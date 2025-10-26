import * as ScoreStorage from './score-storage.js';

const OLD_SCORE_COLLECTION = 'score_v1';
const USER_PROFILE_COLLECTION = 'user_profiles_v1';
const LEADERBOARD_MAX_SIZE = 1000;

export class DataManager {
    constructor(ui, room) {
        this.ui = ui;
        this.room = room;
        this.currentUser = null;
        this.currentUserProfile = null;
        this.migrationInProgress = false;
        this.allProfiles = [];
        this.allOldScores = [];
        this.pendingSubmissions = [];
    }

    async initialize(user) {
        this.currentUser = user;
        this.subscribeToCollections();

        if (this.currentUser) {
            this.migrateUserScores(); // Runs in background
            this.syncLocalScores();
        }
    }

    getPendingSubmissions() {
        return this.pendingSubmissions;
    }

    subscribeToCollections() {
        this.room.collection(USER_PROFILE_COLLECTION).subscribe(profiles => {
            this.allProfiles = profiles;
            if (this.currentUser) {
                this.currentUserProfile = profiles.find(p => p.username === this.currentUser.username) || null;
            }
            this.rebuildLeaderboard();
        });

        this.room.collection(OLD_SCORE_COLLECTION).subscribe(scores => {
            this.allOldScores = scores;
            this.rebuildLeaderboard();
        });
    }

    rebuildLeaderboard() {
        const migratedUsernames = new Set(this.allProfiles.map(p => p.username));

        const leaderboardScores = this.allProfiles.map(profile => {
            const highScoreData = profile.scores?.find(s => s.score === profile.highScore);
            return {
                username: profile.username,
                score: profile.highScore || 0,
                replayUrl: highScoreData ? highScoreData.replayUrl : null,
            };
        });

        const oldScoresByUser = {};
        for (const score of this.allOldScores) {
            if (score.username && !migratedUsernames.has(score.username)) {
                if (!oldScoresByUser[score.username] || score.score > oldScoresByUser[score.username].score) {
                    oldScoresByUser[score.username] = {
                        username: score.username,
                        score: score.score,
                        replayUrl: score.replayUrl || null,
                    };
                }
            }
        }
        Object.values(oldScoresByUser).forEach(score => leaderboardScores.push(score));

        const sortedScores = leaderboardScores.sort((a, b) => b.score - a.score);

        this.ui.updateLeaderboard(sortedScores, (replayUrl) => {
            this.ui.showReplayViewer(replayUrl);
        }, this.currentUserProfile);
    }

    getDataOnce(collection, filterFn = () => true) {
        return new Promise(resolve => {
            const unsubscribe = collection.subscribe(items => {
                const filteredItems = items.filter(filterFn);
                // Ensure it's not just an initial empty list before resolving
                if (items.length > 0 || (items.length === 0 && collection.getList().length === 0)) { 
                    unsubscribe();
                    resolve(filteredItems);
                }
            });
        });
    }

    async migrateUserScores() {
        if (!this.currentUser || this.migrationInProgress) return;
        this.migrationInProgress = true;

        try {
            const [profiles, oldScores] = await Promise.all([
                this.getDataOnce(this.room.collection(USER_PROFILE_COLLECTION), p => p.username === this.currentUser.username),
                this.getDataOnce(this.room.collection(OLD_SCORE_COLLECTION), s => s.username === this.currentUser.username)
            ]);

            let userProfile = profiles[0] || null;

            if (userProfile) {
                this.currentUserProfile = userProfile;
                console.log("User profile already exists. No migration needed.");
                return;
            }

            if (oldScores.length > 0) {
                console.log(`Migrating ${oldScores.length} scores for user ${this.currentUser.username}...`);

                const newScoresArray = oldScores.map(s => ({
                    score: s.score,
                    replayUrl: s.replayUrl || null,
                    timestamp: s.created_at
                })).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

                const highScore = Math.max(...newScoresArray.map(s => s.score), 0);

                const newProfile = await this.room.collection(USER_PROFILE_COLLECTION).create({
                    scores: newScoresArray,
                    highScore: highScore
                });
                this.currentUserProfile = newProfile;
                console.log("Migration successful. New profile created.");

                for (const oldScore of oldScores) {
                    try {
                        await this.room.collection(OLD_SCORE_COLLECTION).delete(oldScore.id);
                    } catch (deleteError) {
                        console.error(`Failed to delete old score ${oldScore.id}:`, deleteError);
                    }
                }
                console.log("Old scores cleaned up.");
            } else {
                console.log("No old scores found to migrate.");
            }
        } catch (error) {
            console.error("Error during score migration:", error);
        } finally {
            this.migrationInProgress = false;
        }
    }

    async submitScore(replayBlob, scoreToSubmit, hasReplay, localTempId = null) {
        if (hasReplay && (!replayBlob || replayBlob.size === 0) && !localTempId) {
            console.warn("Auto-submit cancelled: replay blob is invalid.");
            if (!this.ui.gameOverElement.classList.contains('hidden')) {
                this.ui.setSubmitStatus('Replay failed. Score not submitted.', '#f44336');
            }
            return;
        }

        const isResubmission = !!localTempId;
        let tempId = localTempId;
        let submissionData;

        if (isResubmission) {
            const localScores = ScoreStorage.getUserScores(this.currentUser.username);
            const localScore = localScores.find(s => s.tempId === localTempId);
            if (localScore) {
                submissionData = { ...localScore };
            } else {
                console.error("Could not find local score for resubmission.");
                return;
            }
        } else {
            submissionData = {
                score: scoreToSubmit,
                replayUrl: null,
                timestamp: new Date().toISOString(),
            };
        }

        if (!isResubmission && this.currentUser) {
            tempId = ScoreStorage.saveUserScore(this.currentUser.username, submissionData);
        }

        const leaderboardButton = document.getElementById('leaderboard-button');
        leaderboardButton.classList.add('uploading');
        leaderboardButton.textContent = '⏳';

        const submissionPromise = (async () => {
            let isScoreSubmitted = false;
            try {
                if (!this.currentUser) {
                    throw new Error('Could not get user info for submission.');
                }

                if (this.migrationInProgress) {
                    await new Promise(resolve => {
                        const checkInterval = setInterval(() => {
                            if (!this.migrationInProgress) {
                                clearInterval(checkInterval);
                                resolve();
                            }
                        }, 100);
                    }); 
                } 

                if (this.allProfiles.length >= LEADERBOARD_MAX_SIZE) {
                    const lowestHighScore = this.allProfiles.reduce((min, p) => (p.highScore || 0) < min ? p.highScore : min, Infinity);
                    if (submissionData.score <= lowestHighScore) {
                        console.log('Score too low for full leaderboard.');
                        if (!this.ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                            this.ui.setSubmitStatus(`Score must be > ${lowestHighScore} to make the leaderboard.`, '#ff9800');
                        }
                        if (tempId) ScoreStorage.removeUserScore(this.currentUser.username, tempId);
                        return;
                    }
                }

                const userProfile = this.currentUserProfile;
                const newScoreEntry = {
                    score: submissionData.score,
                    replayUrl: submissionData.replayUrl,
                    timestamp: submissionData.timestamp
                };

                let replayUrl = submissionData.replayUrl;
                if (hasReplay && replayBlob) {
                    try {
                        replayUrl = await window.websim.upload(replayBlob);
                        if (!replayUrl) throw new Error('Upload returned invalid URL');

                        const response = await fetch(replayUrl, { method: 'HEAD' });
                        if (!response.ok) throw new Error('Uploaded file not accessible');
                        if (tempId) ScoreStorage.updateUserScore(this.currentUser.username, tempId, { replayUrl });
                        newScoreEntry.replayUrl = replayUrl;

                    } catch (uploadError) {
                        console.error("Replay upload failed:", uploadError);
                         if (!this.ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                            this.ui.setSubmitStatus('Replay upload failed. Score not submitted.', '#f44336');
                        }
                        if (tempId) ScoreStorage.removeUserScore(this.currentUser.username, tempId);
                        return; 
                    }
                } else if (isResubmission) {
                    const localData = ScoreStorage.getUserScores(this.currentUser.username).find(s => s.tempId === tempId);
                    if (localData && localData.replayUrl) {
                        replayUrl = localData.replayUrl;
                        newScoreEntry.replayUrl = replayUrl;
                    }
                }

                if (hasReplay && !newScoreEntry.replayUrl && !isResubmission) {
                    console.error('Replay upload seems to have failed silently.');
                    if (!this.ui.gameOverElement.classList.contains('hidden')) {
                        this.ui.setSubmitStatus('Replay upload incomplete. Score not submitted.', '#f44336');
                    }
                    if (tempId) ScoreStorage.removeUserScore(this.currentUser.username, tempId);
                    return;
                }

                if (!this.ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                     this.ui.setSubmitStatus('Saving score...', '#ff9800');
                }

                if (userProfile) {
                    let updatedScores = [newScoreEntry, ...(userProfile.scores || [])];

                    if (updatedScores.length > 10) {
                        updatedScores.sort((a, b) => b.score - a.score);
                        updatedScores = updatedScores.slice(0, 10);
                    }

                    const newHighScore = Math.max(submissionData.score, userProfile.highScore || 0);

                    await this.room.collection(USER_PROFILE_COLLECTION).update(userProfile.id, {
                        scores: updatedScores,
                        highScore: newHighScore
                    });

                    if (!this.ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                        this.ui.setSubmitStatus(submissionData.score >= (userProfile.highScore || 0) ? 'High score updated!' : 'Score saved!', '#4CAF50');
                    }
                } else {
                    await this.room.collection(USER_PROFILE_COLLECTION).create({
                        scores: [newScoreEntry],
                        highScore: submissionData.score
                    });
                    if (!this.ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                        this.ui.setSubmitStatus('High score submitted!', '#4CAF50');
                    }
                }
                isScoreSubmitted = true;
                if (tempId) ScoreStorage.removeUserScore(this.currentUser.username, tempId);

            } catch (error) {
                console.error("Failed to auto-submit score:", error);
                if (!this.ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                    this.ui.setSubmitStatus('Error submitting score.', '#f44336');
                }
            } finally {
                if (isScoreSubmitted) {
                    leaderboardButton.classList.remove('uploading');
                    leaderboardButton.classList.add('upload-complete');
                    leaderboardButton.textContent = '✅';

                    setTimeout(() => {
                        leaderboardButton.classList.remove('upload-complete');
                        leaderboardButton.textContent = '🏆';
                    }, 3000);
                } else {
                     leaderboardButton.classList.remove('uploading');
                     leaderboardButton.textContent = '🏆';
                }
            }
        })();

        this.pendingSubmissions.push(submissionPromise);
        submissionPromise.finally(() => {
            const index = this.pendingSubmissions.indexOf(submissionPromise);
            if (index > -1) {
                this.pendingSubmissions.splice(index, 1);
            }
        });
    }

    async syncLocalScores() {
        if (!this.currentUser) return;

        let localScores = ScoreStorage.getUserScores(this.currentUser.username);
        const dbScores = this.currentUserProfile ? (this.currentUserProfile.scores || []) : [];

        if (localScores.length === 0 && dbScores.length === 0) return;

        console.log(`Syncing scores. Local: ${localScores.length}, DB: ${dbScores.length}`);

        const localTimestamps = new Set(localScores.map(s => s.timestamp));
        const dbTimestamps = new Set(dbScores.map(s => s.timestamp));

        const scoresToAddToLocal = dbScores.filter(dbScore => !localTimestamps.has(dbScore.timestamp));
        if (scoresToAddToLocal.length > 0) {
            console.log(`Adding ${scoresToAddToLocal.length} scores from DB to local storage.`);
            scoresToAddToLocal.forEach(score => {
                ScoreStorage.saveUserScore(this.currentUser.username, {
                    score: score.score,
                    replayUrl: score.replayUrl,
                    timestamp: score.timestamp
                });
            });
        }

        localScores = ScoreStorage.getUserScores(this.currentUser.username);

        for (const localScore of localScores) {
            const isSynced = dbTimestamps.has(localScore.timestamp);

            if (isSynced) {
                ScoreStorage.removeUserScore(this.currentUser.username, localScore.tempId);
            } else {
                console.log(`Resubmitting local score: ${localScore.score} from ${localScore.timestamp}`);
                const hasReplay = !!localScore.replayUrl;
                this.submitScore(null, localScore.score, hasReplay, localScore.tempId);
            }
        }
    }
}