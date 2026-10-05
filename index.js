const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const connection = require('./routes/connection');
const uploader = require('./routes/uploader');
const clear = require('./routes/clear');

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    console.log("Created 'uploads' folder ✅");
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend static files
app.use('/', express.static(path.join(__dirname, "public")));
app.use('/uploads', express.static(path.join(__dirname, "uploads")));

// Mount API routes (support both /connection and /connect to prevent route mismatches)
app.use('/connection', connection);
app.use('/connect', connection);
app.use('/upload', uploader);
app.use('/clear', clear);

// Catch-all 404 for unknown API calls
app.use((req, res, next) => {
    if (req.path.startsWith('/connection') || req.path.startsWith('/upload')) {
        return res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
    }
    next();
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
