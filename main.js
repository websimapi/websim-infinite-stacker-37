import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { setupScene } from './setup.js';
import { UIManager } from './ui.js';
import { Game } from './game.js';
import { ReplayRecorder } from './replay.js';
import { CanvasUI } from './canvas-ui.js';
import { AudioManager } from './audio.js';
import { DataManager } from './data-manager.js';

// Global state
let game, ui, canvasUI, audioManager, dataManager;
let scene, world, camera, renderer, uiScene, uiCamera, sky;
let skyScene, skyCamera;

const room = new WebsimSocket();

async function init() {
    const {
        scene: s,
        world: w,
        camera: c,
        renderer: r,
        defaultMaterial: dm,
        uiScene: us,
        uiCamera: uc,
        sky: skyInstance,
        skyScene: ss,
        skyCamera: sc
    } = setupScene();
    scene = s;
    world = w;
    camera = c;
    renderer = r;
    uiScene = us;
    uiCamera = uc;
    sky = skyInstance;
    skyScene = ss;
    skyCamera = sc;

    ui = new UIManager();
    canvasUI = new CanvasUI(uiScene);
    audioManager = new AudioManager();
    dataManager = new DataManager(ui, room);
    audioManager.loadSound('place', 'block_place.mp3');
    audioManager.loadSound('fail', 'fail_sound.mp3');

    window.websim.getCurrentUser().then(async (user) => {
        dataManager.initialize(user);
    });

    const gameCallbacks = {
        onScoreUpdate: (score) => {
            ui.updateScore(score);
            canvasUI.updateScore(score);
        },
        onStreakUpdate: (count, isGolden, isPerfectHit) => {
            ui.updateStreak(count, isGolden, isPerfectHit);
        },
        onGameOver: (score) => {
            const endedGameSession = {
                score,
                replayRecorder: game.getReplayRecorder(),
            };
            
            // Stop the recorder immediately to finalize the video
            endedGameSession.replayRecorder?.stop();

            ui.showGameOver(score);
            ui.setReplayButtonState(true, 'Preparing...');
            
            handleFinishedGame(endedGameSession);
        }
    };

    game = new Game(scene, world, dm, camera, gameCallbacks, audioManager);
    
    setupEventListeners();
    
    renderer.setAnimationLoop(animate);
    startGame();
}

function startGame() {
    const newReplayRecorder = new ReplayRecorder(renderer.domElement, audioManager);
    game.start(newReplayRecorder);
    ui.hideGameOver();
    ui.showInstructions(true);
    canvasUI.updateScore(0);
}

function restart() {
    game.restart();
    startGame();
}

async function handleFinishedGame(session) {
    const { score, replayRecorder } = session;
    if (!replayRecorder) {
        dataManager.submitScore(null, score, false);
        return;
    }

    const replayBlobPromise = replayRecorder.getReplayBlob();

    replayBlobPromise.then(blob => {
        ui.setReplayButtonState(false, 'Watch Replay', blob);
        dataManager.submitScore(blob, score, true);
    }).catch(error => {
        console.error("Error getting replay blob:", error);
        ui.setReplayButtonState(false, 'Replay Failed');
        dataManager.submitScore(null, score, false);
    });
}


async function viewReplay() {
    const blob = ui.getCurrentReplayBlob();
    if (!blob) {
        alert("Replay not available or still processing.");
        return;
    }

    ui.setReplayButtonState(true, 'Loading...');
    try {
        ui.showReplayViewer(blob);
    } catch (error) {
        console.error("Error viewing replay:", error);
        alert("Could not load replay.");
    } finally {
        ui.setReplayButtonState(false, 'Watch Replay', blob);
    }
}

async function submitScore() {
    // This function is no longer used and can be removed or left empty.
    // For safety, we'll just log that it was called.
    console.log("submitScore called, but functionality is now in DataManager.");
}

function setupEventListeners() {
    ui.setupEventListeners({
        onPointerDown: () => {
            audioManager.unlockAudio();
            if (game.getState() === 'playing') {
                ui.showInstructions(false);
                game.onPointerDown();
            }
        },
        onRestart: restart,
        onViewReplay: viewReplay,
        onViewLeaderboard: () => ui.showLeaderboard(),
        onCloseLeaderboard: () => {
            ui.hideLeaderboard();
            const gameState = game.getState();
            if (gameState === 'gameover') {
                ui.showGameOver(game.getScore());
            } else if (gameState !== 'playing') {
                restart();
            }
            // If game is 'playing', do nothing extra, just hide the leaderboard.
        },
        onWindowResize: () => {
            const aspect = window.innerWidth / window.innerHeight;
            const frustumSize = 4;
            camera.left = frustumSize * aspect / -2;
            camera.right = frustumSize * aspect / 2;
            camera.top = frustumSize / 2;
            camera.bottom = frustumSize / -2;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);

            uiCamera.left = -window.innerWidth / 2;
            uiCamera.right = window.innerWidth / 2;
            uiCamera.top = window.innerHeight / 2;
            uiCamera.bottom = -window.innerHeight / 2;
            uiCamera.updateProjectionMatrix();
            canvasUI.onWindowResize();
        }
    });

    window.addEventListener('beforeunload', (event) => {
        if (dataManager && dataManager.getPendingSubmissions().length > 0) {
            event.preventDefault();
            event.returnValue = ''; // For Chrome
            return "Your score is still uploading. Are you sure you want to leave?"; // For older browsers
        }
    });
}

function animate() {
    world.step(1 / 60);
    game.update();
    sky.update();
    
    renderer.clear();

    // Render sky first with its own camera
    renderer.render(skyScene, skyCamera);

    // Render game scene
    renderer.render(scene, camera);

    renderer.clearDepth();
    renderer.render(uiScene, uiCamera);
}

init();