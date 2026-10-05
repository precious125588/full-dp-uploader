const express = require("express");
const Router = express.Router();
const fs = require('fs');
const path = require('path');

async function clearDir() {
    try {
        const uploads = path.join(__dirname, '../uploads');
        const session = path.join(__dirname, '../session');
        const sessions = path.join(__dirname, '../sessions');
        for (const dir of [uploads, session, sessions]) {
            if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
                console.log(`Deleted ${path.basename(dir)} directory.`);
            }
            if (!fs.existsSync(dir)) {
                if (path.basename(dir) !== 'sessions') fs.mkdirSync(dir, { recursive: true });
            }
        }
    } catch (error) {
        console.error('Error while clearing directories:', error);
    }
}

Router.get("/", async (req, res) => {
    await clearDir();
    res.json({ message: "Directories cleared successfully" });
});

module.exports = Router;
