/**
 * StepTool – YouTube SEO Tag Extractor Pro
 * Backend: Node.js + Express
 */

const path = require("path");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3001;

// ─── MIDDLEWARE ─────────────────────────────────────────
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname)));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Rate limiter
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", limiter);

// ─── CONFIG ────────────────────────────────────────────
const YT_API_KEY = process.env.YOUTUBE_API_KEY || "";
const YT_BASE = "https://www.googleapis.com/youtube/v3";

if (!YT_API_KEY) {
  console.warn("⚠️ YOUTUBE_API_KEY missing");
}

// ─── HELPERS ───────────────────────────────────────────

function extractVideoId(input) {
  if (!input) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  return null;
}

function detectMode(input) {
  return /youtube\.com|youtu\.be/.test(input) ? "url" : "keyword";
}

async function fetchVideoData(videoId) {
  try {
    const url = `${YT_BASE}/videos?part=snippet,statistics&id=${videoId}&key=${YT_API_KEY}`;
    const { data } = await axios.get(url, { timeout: 8000 });

    if (!data.items?.length) return null;

    const item = data.items[0];

    return {
      id: videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      tags: item.snippet.tags || [],
      thumbnail: item.snippet.thumbnails?.high?.url || "",
      viewCount: parseInt(item.statistics?.viewCount || "0"),
    };
  } catch (err) {
    console.error("fetchVideoData:", err.message);
    return null;
  }
}

async function scrapeYouTubeTags(videoId) {
  try {
    const { data: html } = await axios.get(
      `https://www.youtube.com/watch?v=${videoId}`,
      {
        timeout: 10000,
        headers: { "User-Agent": "Mozilla/5.0" },
      }
    );

    const $ = cheerio.load(html);
    const meta = $('meta[name="keywords"]').attr("content");

    if (!meta) return [];

    return meta.split(",").map((t) => t.trim());
  } catch (err) {
    console.error("scrape error:", err.message);
    return [];
  }
}

async function fetchCompetitors(query) {
  try {
    const url = `${YT_BASE}/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=5&key=${YT_API_KEY}`;
    const { data } = await axios.get(url, { timeout: 8000 });

    return (data.items || []).map((i) => ({
      id: i.id.videoId,
      title: i.snippet.title,
    }));
  } catch (err) {
    console.error("competitor error:", err.message);
    return [];
  }
}

function buildViralTags(tags) {
  const freq = {};
  tags.forEach((t) => {
    t = t.toLowerCase();
    freq[t] = (freq[t] || 0) + 1;
  });

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tag]) => tag);
}

function generateLongTail(tags) {
  const prefix = ["how to", "best", "easy", "guide"];
  const out = [];

  tags.slice(0, 5).forEach((t) => {
    prefix.forEach((p) => out.push(`${p} ${t}`));
  });

  return out.slice(0, 20);
}

// Safe copy string
function buildCopyString(tags, max = 500) {
  let result = "";
  for (let t of tags) {
    if ((result + ", " + t).length > max) break;
    result += (result ? ", " : "") + t;
  }
  return result;
}

// ─── ROUTES ────────────────────────────────────────────

app.get("/api/health", (_, res) => {
  res.json({ ok: true });
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { input } = req.body;

    if (!input) {
      return res.status(400).json({ error: "Input required" });
    }

    const mode = detectMode(input);
    const videoId = extractVideoId(input);

    let videoData = null;
    let tags = [];

    if (videoId) {
      videoData = await fetchVideoData(videoId);

      if (!videoData) {
        return res.status(404).json({ error: "Video not found" });
      }

      tags = videoData.tags.length
        ? videoData.tags
        : await scrapeYouTubeTags(videoId);
    }

    const competitors = await fetchCompetitors(
      videoData?.title || input
    );

    const competitorTags = competitors.map((c) => c.title);

    const allTags = [...tags, ...competitorTags];

    const viral = buildViralTags(allTags);
    const longTail = generateLongTail(viral);

    const copyString = buildCopyString([
      ...viral.slice(0, 10),
      ...longTail.slice(0, 5),
    ]);

    res.json({
      mode,
      videoData,
      tags: {
        original: tags,
        viral,
        longTail,
      },
      copyString,
    });
  } catch (err) {
    console.error("MAIN ERROR:", err);
    res.status(500).json({ error: "Server crashed" });
  }
});

// ─── START ─────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = app;
