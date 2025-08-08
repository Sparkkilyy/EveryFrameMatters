const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv').config()
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const env = process.env

const PORT = process.env.PORT || 3000;

// Security configuration
const ADMIN_REGISTRATION_KEY = process.env.ADMIN_KEY || 'skibidiskibidiaype';
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours
const SALT_ROUNDS = 12;
const IMAGE_ASSIGNMENT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

const DISCORD_PROGRESS_WEBHOOK = env.DISCORD_WEBHOOK

// Data file paths
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const LABELS_FILE = path.join(DATA_DIR, 'imageLabels.json');
const COMPLETED_FILE = path.join(DATA_DIR, 'completedImages.json');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');

// Rate limiting
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // limit each IP to 5 requests per windowMs
    message: { error: 'Too many login attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use('/images', express.static('images'));
app.use(generalLimiter);

// In-memory storage for sessions and real-time state
let sessions = {};
let users = {};
let imageLabels = {};
let images = [];
let completedImages = new Set();

// Real-time synchronization state
let imageAssignments = new Map(); // imageIndex -> { username, assignedAt, socketId }
let connectedUsers = new Map(); // socketId -> { username, token }

let lastAnnouncedPercent = 0;

// Ensure data directory exists
function ensureDataDirectory() {
    if (!fsSync.existsSync(DATA_DIR)) {
        fsSync.mkdirSync(DATA_DIR, { recursive: true });
        console.log('Created data directory for persistent storage');
    }
}

// Save data to files
async function saveUsers() {
    try {
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
        console.log('Users data saved successfully');
    } catch (error) {
        console.error('Error saving users data:', error);
    }
}

async function saveImageLabels() {
    try {
        await fs.writeFile(LABELS_FILE, JSON.stringify(imageLabels, null, 2));
        console.log('Image labels data saved successfully');
    } catch (error) {
        console.error('Error saving image labels data:', error);
    }
}

async function loadLastAnnouncedPercent() {
    try {
        if (fsSync.existsSync(PROGRESS_FILE)) {
            const data = await fs.readFile(PROGRESS_FILE, 'utf8');
            const parsed = JSON.parse(data);
            lastAnnouncedPercent = parsed.lastAnnouncedPercent || 0;
            console.log(`Loaded last announced percent: ${lastAnnouncedPercent}%`);
        }
    } catch (error) {
        console.warn('Could not load last announced percent:', error);
        lastAnnouncedPercent = 0;
    }
}

// Save last announced percent to persistent storage
async function saveLastAnnouncedPercent() {
    try {
        await fs.writeFile(PROGRESS_FILE, JSON.stringify({ lastAnnouncedPercent }, null, 2));
    } catch (error) {
        console.warn('Could not save last announced percent:', error);
    }
}

async function saveCompletedImages() {
    try {
        const completedArray = Array.from(completedImages);
        await fs.writeFile(COMPLETED_FILE, JSON.stringify(completedArray, null, 2));
        console.log('Completed images data saved successfully');
    } catch (error) {
        console.error('Error saving completed images data:', error);
    }
}

// Load data from files
async function loadUsers() {
    try {
        if (fsSync.existsSync(USERS_FILE)) {
            const data = await fs.readFile(USERS_FILE, 'utf8');
            users = JSON.parse(data);
            console.log(`Loaded ${Object.keys(users).length} users from persistent storage`);
        } else {
            users = {};
            console.log('No existing users file found, starting with empty user database');
        }
    } catch (error) {
        console.error('Error loading users data:', error);
        users = {};
    }
}

async function loadImageLabels() {
    try {
        if (fsSync.existsSync(LABELS_FILE)) {
            const data = await fs.readFile(LABELS_FILE, 'utf8');
            imageLabels = JSON.parse(data);
            console.log(`Loaded labels for ${Object.keys(imageLabels).length} images from persistent storage`);
        } else {
            imageLabels = {};
            console.log('No existing image labels file found, starting fresh');
        }
    } catch (error) {
        console.error('Error loading image labels data:', error);
        imageLabels = {};
    }
}

async function loadCompletedImages() {
    try {
        if (fsSync.existsSync(COMPLETED_FILE)) {
            const data = await fs.readFile(COMPLETED_FILE, 'utf8');
            const completedArray = JSON.parse(data);
            completedImages = new Set(completedArray);
            console.log(`Loaded ${completedImages.size} completed images from persistent storage`);
        } else {
            completedImages = new Set();
            console.log('No existing completed images file found, starting fresh');
        }
    } catch (error) {
        console.error('Error loading completed images data:', error);
        completedImages = new Set();
    }
}

// Session cleanup interval
setInterval(() => {
    const now = Date.now();
    let cleanedSessions = 0;
    Object.keys(sessions).forEach(token => {
        if (now - sessions[token].loginTime.getTime() > SESSION_TIMEOUT) {
            delete sessions[token];
            cleanedSessions++;
        }
    });
    if (cleanedSessions > 0) {
        console.log(`Cleaned up ${cleanedSessions} expired sessions`);
    }
}, 60 * 60 * 1000); // Clean up every hour

// Image assignment cleanup interval
setInterval(() => {
    const now = Date.now();
    let cleanedAssignments = 0;

    imageAssignments.forEach((assignment, imageIndex) => {
        if (now - assignment.assignedAt > IMAGE_ASSIGNMENT_TIMEOUT) {
            imageAssignments.delete(imageIndex);
            cleanedAssignments++;
            console.log(`Released expired image assignment: ${imageIndex} from ${assignment.username}`);

            // Notify all connected clients about the availability change
            broadcastProgressUpdate();
        }
    });

    if (cleanedAssignments > 0) {
        console.log(`Cleaned up ${cleanedAssignments} expired image assignments`);
    }
}, 30 * 1000); // Clean up every 30 seconds

// Load images from folder
async function loadImagesFromFolder() {
    const imagesDir = path.join(__dirname, 'images');

    if (!fsSync.existsSync(imagesDir)) {
        fsSync.mkdirSync(imagesDir);
        console.log('Created images directory. Please add your images to the /images folder.');
        console.log('Supported formats: .jpg, .jpeg, .png, .gif, .webp, .bmp');
        return;
    }

    try {
        const files = await fs.readdir(imagesDir);
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

        images = files
            .filter(file => {
                const ext = path.extname(file).toLowerCase();
                return imageExtensions.includes(ext);
            })
            .map(file => `/images/${file}`)
            .sort();

        console.log(`Loaded ${images.length} images from the images folder`);

        if (images.length === 0) {
            console.log('No images found in the /images folder.');
            console.log('Please add image files with these extensions: .jpg, .jpeg, .png, .gif, .webp, .bmp');
        }

        // Initialize or update image labels storage
        images.forEach((img, index) => {
            if (!imageLabels[index]) {
                imageLabels[index] = {
                    url: img,
                    filename: path.basename(img),
                    interesting: 0,
                    notInteresting: 0,
                    labels: [],
                    labeledBy: null,
                    isCompleted: false
                };
            } else {
                // Update URL and filename in case the file was renamed or moved
                imageLabels[index].url = img;
                imageLabels[index].filename = path.basename(img);
            }
        });

        // Save updated image labels structure
        await saveImageLabels();

    } catch (error) {
        console.error('Error loading images from folder:', error);
        images = [];
    }
}

// Function to get a random unassigned and unlabeled image
function getRandomUnassignedImage() {
    const availableIndices = [];

    for (let i = 0; i < images.length; i++) {
        // Skip if image is completed or currently assigned to someone
        if (!completedImages.has(i) && !imageAssignments.has(i)) {
            availableIndices.push(i);
        }
    }

    if (availableIndices.length === 0) {
        return null; // No available images
    }

    // Return random available image index
    const randomIndex = Math.floor(Math.random() * availableIndices.length);
    return availableIndices[randomIndex];
}

// Function to assign an image to a user
function assignImageToUser(imageIndex, username, socketId) {
    imageAssignments.set(imageIndex, {
        username,
        assignedAt: Date.now(),
        socketId
    });

    console.log(`Assigned image ${imageIndex} to ${username}`);
}

// Function to release an image assignment
function releaseImageAssignment(imageIndex, username) {
    const assignment = imageAssignments.get(imageIndex);
    if (assignment && assignment.username === username) {
        imageAssignments.delete(imageIndex);
        console.log(`Released image ${imageIndex} from ${username}`);
        broadcastProgressUpdate();
        return true;
    }
    return false;
}

// Function to broadcast progress updates to all connected clients
function broadcastProgressUpdate() {
    const progressData = {
        totalImages: images.length,
        completedImages: completedImages.size,
        assignedImages: imageAssignments.size,
        remainingImages: images.length - completedImages.size - imageAssignments.size,
        allCompleted: completedImages.size >= images.length
    };

    io.emit('progressUpdate', progressData);

    // Discord webhook notification (per 1% milestone)
    if (images.length > 0) {
        const percent = Math.floor((completedImages.size / images.length) * 100);

        if (percent > lastAnnouncedPercent && percent <= 100) {
            if (DISCORD_PROGRESS_WEBHOOK) {
                axios.post(DISCORD_PROGRESS_WEBHOOK, {
                    content: `🎉 Progress update: **${percent}%** images labeled! (${completedImages.size}/${images.length})`
                }).then(() => {
                    console.log(`✅ Sent Discord webhook: ${percent}%`);
                }).catch(err => {
                    console.error('❌ Discord webhook failed:', err);
                });
            }
            lastAnnouncedPercent = percent;
	    saveLastAnnouncedPercent();
        }
    }
}

function generateSecureToken() {
    return crypto.randomBytes(32).toString('hex');
}

// Generate cryptographically secure session token
function validateInput(data, required = []) {
    const errors = [];

    required.forEach(field => {
        if (!data[field] || typeof data[field] !== 'string' || data[field].trim().length === 0) {
            errors.push(`${field} is required`);
        }
    });

    return errors;
}

// Input validation
function sanitizeUsername(username) {
    return username.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
}

// Middleware to check authentication
function authenticateToken(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    const session = sessions[token];
    if (!session) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Check if session has expired
    if (Date.now() - session.loginTime.getTime() > SESSION_TIMEOUT) {
        delete sessions[token];
        return res.status(401).json({ error: 'Session expired' });
    }

    // Update last activity
    session.lastActivity = new Date();
    req.user = session;
    req.token = token;
    next();
}

// WebSocket authentication middleware
function authenticateSocket(socket, token) {
    const session = sessions[token];
    if (!session) {
        return false;
    }

    // Check if session has expired
    if (Date.now() - session.loginTime.getTime() > SESSION_TIMEOUT) {
        delete sessions[token];
        return false;
    }

    return session;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`New socket connection: ${socket.id}`);

    socket.on('authenticate', (token) => {
        const session = authenticateSocket(socket, token);
        if (session) {
            connectedUsers.set(socket.id, { username: session.username, token });
            socket.join('authenticated');

            console.log(`User ${session.username} connected via WebSocket`);

            // Send current progress to the newly connected user
            broadcastProgressUpdate();

            socket.emit('authenticated', { username: session.username });
        } else {
            socket.emit('authError', 'Invalid or expired token');
            socket.disconnect();
        }
    });

    socket.on('requestImage', async () => {
        const user = connectedUsers.get(socket.id);
        if (!user) {
            socket.emit('error', 'Not authenticated');
            return;
        }

        // Release any existing assignment for this user
        imageAssignments.forEach((assignment, imageIndex) => {
            if (assignment.username === user.username) {
                imageAssignments.delete(imageIndex);
            }
        });

        const imageIndex = getRandomUnassignedImage();
        if (imageIndex === null) {
            socket.emit('noImagesAvailable', {
                completed: completedImages.size >= images.length,
                message: completedImages.size >= images.length ? 'All images have been labeled!' : 'No images currently available. Try again in a moment.'
            });
            return;
        }

        // Assign the image to this user
        assignImageToUser(imageIndex, user.username, socket.id);

        socket.emit('imageAssigned', {
            imageUrl: images[imageIndex],
            imageIndex: imageIndex,
            filename: path.basename(images[imageIndex]),
            totalImages: images.length,
            completedImages: completedImages.size,
            remainingImages: images.length - completedImages.size,
            completed: false
        });

        // Broadcast updated progress to all users
        broadcastProgressUpdate();
    });

    socket.on('disconnect', () => {
        const user = connectedUsers.get(socket.id);
        if (user) {
            console.log(`User ${user.username} disconnected`);

            // Release any image assignments for this user
            imageAssignments.forEach((assignment, imageIndex) => {
                if (assignment.socketId === socket.id) {
                    imageAssignments.delete(imageIndex);
                    console.log(`Released image ${imageIndex} due to user disconnect`);
                }
            });

            connectedUsers.delete(socket.id);
            broadcastProgressUpdate();
        } else {
            console.log(`Anonymous socket disconnected: ${socket.id}`);
        }
    });
});

// Routes
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, adminKey } = req.body;

        // Validate admin key first
        if (adminKey !== ADMIN_REGISTRATION_KEY) {
            return res.status(403).json({ error: 'Invalid admin key. Registration is restricted.' });
        }

        const errors = validateInput({ username, password }, ['username', 'password']);
        if (errors.length > 0) {
            return res.status(400).json({ error: errors.join(', ') });
        }

        // Validate password strength
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters long' });
        }

        const sanitizedUsername = sanitizeUsername(username);
        if (sanitizedUsername.length < 3) {
            return res.status(400).json({ error: 'Username must be at least 3 characters long and contain only letters, numbers, and underscores' });
        }

        if (users[sanitizedUsername]) {
            return res.status(400).json({ error: 'User already exists' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

        users[sanitizedUsername] = {
            username: sanitizedUsername,
            password: hashedPassword,
            createdAt: new Date().toISOString()
        };

        // Save users to persistent storage
        await saveUsers();

        console.log(`New user registered: ${sanitizedUsername}`);

        res.json({
            message: 'User registered successfully',
            username: sanitizedUsername
        });

    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.post('/api/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;

        const errors = validateInput({ username, password }, ['username', 'password']);
        if (errors.length > 0) {
            return res.status(400).json({ error: errors.join(', ') });
        }

        const sanitizedUsername = sanitizeUsername(username);
        const user = users[sanitizedUsername];

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = generateSecureToken();
        sessions[token] = {
            username: sanitizedUsername,
            loginTime: new Date(),
            lastActivity: new Date()
        };

        console.log(`User logged in: ${sanitizedUsername}`);

        res.json({
            token,
            username: sanitizedUsername,
            expiresIn: SESSION_TIMEOUT
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.post('/api/logout', authenticateToken, (req, res) => {
    const username = req.user.username;

    // Release any image assignments for this user
    imageAssignments.forEach((assignment, imageIndex) => {
        if (assignment.username === username) {
            imageAssignments.delete(imageIndex);
            console.log(`Released image ${imageIndex} due to logout`);
        }
    });

    // Remove from connected users
    connectedUsers.forEach((user, socketId) => {
        if (user.username === username) {
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
                socket.disconnect();
            }
            connectedUsers.delete(socketId);
        }
    });

    console.log(`User logged out: ${username}`);
    delete sessions[req.token];

    broadcastProgressUpdate();
    res.json({ message: 'Logged out successfully' });
});

app.post('/api/label-image', authenticateToken, async (req, res) => {
    try {
        const { imageIndex, isInteresting } = req.body;
        const username = req.user.username;

        // Validate input
        if (typeof imageIndex !== 'number' || typeof isInteresting !== 'boolean') {
            return res.status(400).json({ error: 'Invalid input data' });
        }

        // Check if this image was already completed
        if (completedImages.has(imageIndex)) {
            return res.status(400).json({
                error: 'This image has already been labeled by another user',
                alreadyCompleted: true
            });
        }

        // Check if this image is assigned to this user
        const assignment = imageAssignments.get(imageIndex);
        if (!assignment || assignment.username !== username) {
            return res.status(400).json({ error: 'Invalid image assignment' });
        }

        if (imageIndex < 0 || imageIndex >= images.length) {
            return res.status(400).json({ error: 'Image index out of range' });
        }

        // Store the label
        if (imageLabels[imageIndex]) {
            if (isInteresting) {
                imageLabels[imageIndex].interesting++;
            } else {
                imageLabels[imageIndex].notInteresting++;
            }

            imageLabels[imageIndex].labels.push({
                username,
                isInteresting,
                timestamp: new Date().toISOString()
            });

            // Mark as completed
            imageLabels[imageIndex].labeledBy = username;
            imageLabels[imageIndex].isCompleted = true;
            completedImages.add(imageIndex);

            // Release this image assignment
            imageAssignments.delete(imageIndex);

            // Save the updated data to persistent storage
            await Promise.all([
                saveImageLabels(),
                saveCompletedImages()
            ]);
        }

        console.log(`Image ${imageIndex} (${path.basename(images[imageIndex])}) labeled as ${isInteresting ? 'interesting' : 'not interesting'} by ${username}`);
        console.log(`Progress: ${completedImages.size}/${images.length} images completed`);

        // Broadcast progress update to all connected clients
        broadcastProgressUpdate();

        // Notify all clients about the completion
        io.to('authenticated').emit('imageCompleted', {
            imageIndex,
            filename: path.basename(images[imageIndex]),
            isInteresting,
            labeledBy: username,
            completedImages: completedImages.size,
            totalImages: images.length
        });

        res.json({
            message: 'Label recorded successfully',
            completedImages: completedImages.size,
            totalImages: images.length,
            remainingImages: images.length - completedImages.size,
            completed: completedImages.size >= images.length
        });

    } catch (error) {
        console.error('Label image error:', error);
        res.status(500).json({ error: 'Failed to record label' });
    }
});

app.get('/api/results', authenticateToken, (req, res) => {
    try {
        res.json({
            totalImages: images.length,
            completedImages: completedImages.size,
            remainingImages: Math.max(0, images.length - completedImages.size),
            results: imageLabels,
            summary: Object.values(imageLabels).map((img, index) => ({
                filename: img.filename,
                url: img.url,
                interesting: img.interesting,
                notInteresting: img.notInteresting,
                totalVotes: img.interesting + img.notInteresting,
                labeledBy: img.labeledBy,
                isCompleted: img.isCompleted || false
            }))
        });
    } catch (error) {
        console.error('Results error:', error);
        res.status(500).json({ error: 'Failed to load results' });
    }
});

// Data management endpoints (for admin use)
app.get('/api/backup', authenticateToken, async (req, res) => {
    try {
        const backupData = {
            users: users,
            imageLabels: imageLabels,
            completedImages: Array.from(completedImages),
            exportedAt: new Date().toISOString(),
            totalImages: images.length
        };

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="image-labeling-backup-${new Date().toISOString().split('T')[0]}.json"`);
        res.json(backupData);
    } catch (error) {
        console.error('Backup error:', error);
        res.status(500).json({ error: 'Failed to create backup' });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        imagesLoaded: images.length,
        imagesCompleted: completedImages.size,
        imagesAssigned: imageAssignments.size,
        imagesRemaining: Math.max(0, images.length - completedImages.size - imageAssignments.size),
        progressPercent: images.length > 0 ? Math.round((completedImages.size / images.length) * 100) : 0,
        activeSessions: Object.keys(sessions).length,
        connectedUsers: connectedUsers.size,
        registeredUsers: Object.keys(users).length,
        persistentStorage: {
            dataDirectory: DATA_DIR,
            usersFile: fsSync.existsSync(USERS_FILE),
            labelsFile: fsSync.existsSync(LABELS_FILE),
            completedFile: fsSync.existsSync(COMPLETED_FILE)
        }
    });
});

// Serve the frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Initialize the application
async function initializeApp() {
    console.log('🚀 Initializing Synchronized Image Labeling Server...');

    // Ensure data directory exists
    ensureDataDirectory();

    // Load persistent data
    console.log('📂 Loading persistent data...');
    await Promise.all([
        loadUsers(),
        loadImageLabels(),
        loadCompletedImages()
    ]);

    // Load images from folder
    console.log('🖼️  Loading images...');
    await loadImagesFromFolder();

    await loadLastAnnouncedPercent();

    // Start the server
    server.listen(PORT, () => {
        console.log('');
        console.log('🎉 Synchronized Image Labeling Server Started Successfully!');
        console.log('='.repeat(60));
        console.log(`🌐 Server running on port ${PORT}`);
        console.log(`🔌 WebSocket server running for real-time sync`);
        console.log(`🔑 Admin registration key: ${ADMIN_REGISTRATION_KEY}`);
        console.log('⚠️  IMPORTANT: Change the ADMIN_KEY environment variable in production!');
        console.log('');
        console.log('📊 Current Status:');
        console.log(`   👥 Registered users: ${Object.keys(users).length}`);
        console.log(`   🖼️  Images loaded: ${images.length}`);
        console.log(`   ✅ Images completed: ${completedImages.size}/${images.length}`);
        console.log(`   🔄 Real-time sync: Enabled`);
        console.log(`   ⏱️  Session timeout: ${SESSION_TIMEOUT / 1000 / 60} minutes`);
        console.log(`   ⏱️  Image assignment timeout: ${IMAGE_ASSIGNMENT_TIMEOUT / 1000 / 60} minutes`);
        console.log('');
        console.log('💾 Persistent Storage:');
        console.log(`   📁 Data directory: ${DATA_DIR}`);
        console.log(`   👤 Users file: ${fsSync.existsSync(USERS_FILE) ? '✅ Found' : '❌ Not found'}`);
        console.log(`   🏷️  Labels file: ${fsSync.existsSync(LABELS_FILE) ? '✅ Found' : '❌ Not found'}`);
        console.log(`   🎯 Completed file: ${fsSync.existsSync(COMPLETED_FILE) ? '✅ Found' : '❌ Not found'}`);
        console.log('='.repeat(60));

        if (images.length === 0) {
            console.log('\n⚠️  No images found! Please add images to the /images folder.');
        } else if (completedImages.size >= images.length) {
            console.log('🎉 All images have been labeled!');
        }
    });
}

// Graceful shutdown with data saving
async function gracefulShutdown(signal) {
    console.log(`\n📤 Received ${signal}, performing graceful shutdown...`);

    try {
        // Close WebSocket connections
        io.close();

        // Save all data one final time
        console.log('💾 Saving all data...');
        await Promise.all([
            saveUsers(),
            saveImageLabels(),
            saveCompletedImages()
        ]);
        console.log('✅ All data saved successfully');
    } catch (error) {
        console.error('❌ Error saving data during shutdown:', error);
    }

    console.log('👋 Server shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start the application
initializeApp().catch(error => {
    console.error('❌ Failed to initialize application:', error);
    process.exit(1);
});
