// Profile persistence layer.
// Uses MongoDB when MONGODB_URI is set; otherwise a local JSON file (dev/testing).
// The file store is NOT durable on Render's ephemeral disk — set MONGODB_URI in
// production to keep accounts across deploys/restarts.
const fs = require('fs');
const path = require('path');

let backend = 'file';
let mongoColl = null;
let mongoClient = null;
const filePath = path.join(__dirname, 'data', 'profiles.json');
let fileCache = {};

// Load the file store synchronously so reads work immediately on boot.
try {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) fileCache = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '{}');
} catch (e) {
  fileCache = {};
}

function persistFile() {
  try { fs.writeFileSync(filePath, JSON.stringify(fileCache)); } catch (e) {}
}

async function init() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log('DB: local file store (set MONGODB_URI for persistent cloud accounts).');
    return;
  }
  try {
    const { MongoClient } = require('mongodb');
    mongoClient = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    await mongoClient.connect();
    const dbName = process.env.MONGODB_DB || 'wordrace';
    mongoColl = mongoClient.db(dbName).collection('profiles');
    await mongoColl.createIndex({ id: 1 }, { unique: true });
    backend = 'mongodb';
    console.log('DB: connected to MongoDB (db=' + dbName + ').');
  } catch (e) {
    backend = 'file';
    console.warn('DB: MongoDB unavailable, using file store:', e.message);
  }
}

async function getProfile(id) {
  if (!id) return null;
  if (backend === 'mongodb') {
    const doc = await mongoColl.findOne({ id });
    if (!doc) return null;
    delete doc._id;
    return doc;
  }
  return fileCache[id] || null;
}

async function saveProfile(id, profile) {
  if (!id) return null;
  const doc = Object.assign({}, profile, { id, updatedAt: Date.now() });
  if (backend === 'mongodb') {
    await mongoColl.updateOne({ id }, { $set: doc }, { upsert: true });
    return doc;
  }
  fileCache[id] = doc;
  persistFile();
  return doc;
}

function info() {
  return { backend, configured: backend === 'mongodb' };
}

module.exports = { init, getProfile, saveProfile, info };
