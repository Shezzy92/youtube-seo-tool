/**
 * StepTool – YouTube SEO Tag Extractor Pro
 * Backend: Node.js + Express
 * Deploy: Railway / Render / Fly.io / VPS
 */
const path = require("path");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3001;
// Serve frontend files (VERY IMPORTANT)
app.use(express.static(path.join(__dirname)));

// Root route (REQUIRED for Railway)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ─── SECURITY / MIDDLEWARE ────────────────────────────────────────────────────
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,      // 1 minute
  max: 20,                   // 20 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment." },
});
app.use("/api/", limiter);

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const YT_API_KEY = process.env.YOUTUBE_API_KEY || "";
const YT_BASE    = "https://www.googleapis.com/youtube/v3";

if (!YT_API_KEY) {
  console.warn("⚠️  YOUTUBE_API_KEY not set – API routes will fail.");
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Extract video ID from any YouTube URL format */
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

/** Determine if input is a URL or keyword */
function detectMode(input) {
  return /youtube\.com|youtu\.be/.test(input) ? "url" : "keyword";
}

/** Fetch video data from YouTube Data API v3 */
async function fetchVideoData(videoId) {
  const url = `${YT_BASE}/videos?part=snippet,statistics&id=${videoId}&key=${YT_API_KEY}`;
  const { data } = await axios.get(url, { timeout: 8000 });
  if (!data.items || data.items.length === 0) return null;
  const item = data.items[0];
  const s = item.snippet;
  const st = item.statistics;
  return {
    id: videoId,
    title: s.title,
    description: s.description,
    tags: s.tags || [],
    categoryId: s.categoryId,
    publishedAt: s.publishedAt,
    channelTitle: s.channelTitle,
    thumbnail: s.thumbnails?.high?.url || s.thumbnails?.medium?.url || "",
    viewCount: parseInt(st.viewCount || "0", 10),
    likeCount: parseInt(st.likeCount || "0", 10),
    commentCount: parseInt(st.commentCount || "0", 10),
  };
}

/** Scrape tags from YouTube HTML page (fallback) */
async function scrapeYouTubeTags(videoId) {
  try {
    const { data: html } = await axios.get(
      `https://www.youtube.com/watch?v=${videoId}`,
      {
        timeout: 10000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
      }
    );

    const tags = [];

    // Meta keywords
    const $ = cheerio.load(html);
    const metaKeywords = $('meta[name="keywords"]').attr("content");
    if (metaKeywords) {
      tags.push(...metaKeywords.split(",").map((t) => t.trim()).filter(Boolean));
    }

    // ytInitialData keywords
    const initDataMatch = html.match(/ytInitialData\s*=\s*(\{.+?\})(?:;|\n)/s);
    if (initDataMatch) {
      try {
        const yd = JSON.parse(initDataMatch[1]);
        const keywordsStr =
          yd?.microformat?.playerMicroformatRenderer?.keywords;
        if (Array.isArray(keywordsStr)) tags.push(...keywordsStr);
      } catch (_) {}
    }

    return [...new Set(tags)];
  } catch (err) {
    console.error("Scrape failed:", err.message);
    return [];
  }
}

/** Search competitor videos */
async function fetchCompetitors(query, maxResults = 5) {
  const url = `${YT_BASE}/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${maxResults}&key=${YT_API_KEY}`;
  const { data } = await axios.get(url, { timeout: 8000 });
  return (data.items || []).map((item) => ({
    id: item.id.videoId,
    title: item.snippet.title,
    channel: item.snippet.channelTitle,
    publishedAt: item.snippet.publishedAt,
    thumbnail: item.snippet.thumbnails?.medium?.url || "",
  }));
}

/** Fetch tags for a list of video IDs in one batch call */
async function fetchTagsBatch(videoIds) {
  if (!videoIds.length) return {};
  const ids = videoIds.join(",");
  const url = `${YT_BASE}/videos?part=snippet,statistics&id=${ids}&key=${YT_API_KEY}`;
  const { data } = await axios.get(url, { timeout: 8000 });
  const map = {};
  for (const item of data.items || []) {
    map[item.id] = {
      tags: item.snippet.tags || [],
      viewCount: parseInt(item.statistics?.viewCount || "0", 10),
    };
  }
  return map;
}

/** Build viral tags via frequency analysis */
function buildViralTags(allTags, limit = 20) {
  const freq = {};
  for (const tag of allTags) {
    const t = tag.toLowerCase().trim();
    if (t.length < 2) continue;
    freq[t] = (freq[t] || 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}

/** Generate long-tail variations */
function generateLongTail(seedTags, title) {
  const prefixes = [
    "how to", "best way to", "complete guide to", "step by step",
    "for beginners", "tutorial", "tips for", "learn", "easy", "quick",
  ];
  const seeds = [...new Set([
    ...seedTags.slice(0, 5),
    ...title.toLowerCase().split(" ").filter((w) => w.length > 3),
  ])].slice(0, 6);

  const results = new Set();
  for (const seed of seeds) {
    for (const prefix of prefixes) {
      results.add(`${prefix} ${seed}`);
    }
  }
  return [...results].slice(0, 25);
}

/** Low competition tags = appear once, length > 3 words */
function findEasyRankTags(allTags) {
  const freq = {};
  for (const tag of allTags) {
    const t = tag.toLowerCase().trim();
    freq[t] = (freq[t] || 0) + 1;
  }
  return Object.entries(freq)
    .filter(([tag, count]) => count === 1 && tag.split(" ").length >= 3)
    .map(([tag]) => tag)
    .slice(0, 15);
}

/** SEO Score Engine */
function calcSeoScore(originalTags, viralTags, longTailTags, easyTags) {
  let score = 0;
  score += Math.min(originalTags.length * 2, 30);   // up to 30
  score += Math.min(viralTags.length * 1.5, 25);    // up to 25
  score += Math.min(longTailTags.length, 25);        // up to 25
  score += Math.min(easyTags.length * 1.5, 20);     // up to 20
  score = Math.round(Math.min(score, 100));
  const label = score >= 70 ? "High" : score >= 40 ? "Medium" : "Low";
  return { score, label };
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

/** Health check */
app.get("/api/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

/**
 * POST /api/analyze
 * Body: { input: string }
 */
app.post("/api/analyze", async (req, res) => {
  const { input } = req.body;
  if (!input || typeof input !== "string" || input.trim().length < 2) {
    return res.status(400).json({ error: "Invalid input." });
  }

  const query = input.trim();
  const mode = detectMode(query);
  let videoId = mode === "url" ? extractVideoId(query) : null;

  try {
    let videoData = null;
    let searchQuery = query;

    // ── Step 1: Video data ────────────────────────────────────────────────
    if (videoId) {
      videoData = await fetchVideoData(videoId);
      if (!videoData) {
        return res.status(404).json({ error: "Video not found." });
      }
      // Fallback scrape if no tags
      if (!videoData.tags.length) {
        videoData.tags = await scrapeYouTubeTags(videoId);
      }
      searchQuery = videoData.title;
    }

    // ── Step 2: Competitor search ─────────────────────────────────────────
    const competitors = await fetchCompetitors(searchQuery, 5);

    // ── Step 3: Fetch competitor tags (batch) ─────────────────────────────
    const competitorIds = competitors.map((c) => c.id).filter(Boolean);
    const competitorTagMap = await fetchTagsBatch(competitorIds);

    // Enrich competitor objects
    for (const c of competitors) {
      const cm = competitorTagMap[c.id] || {};
      c.tags = cm.tags || [];
      c.viewCount = cm.viewCount || 0;
    }

    // ── Step 4: Build tag pools ───────────────────────────────────────────
    const originalTags = videoData?.tags || [];
    const competitorTags = competitors.flatMap((c) => c.tags);
    const allTags = [...originalTags, ...competitorTags];

    const viralTags    = buildViralTags(allTags, 20);
    const longTailTags = generateLongTail(
      viralTags.map((v) => v.tag),
      searchQuery
    );
    const easyRankTags = findEasyRankTags(allTags);
    const seoScore     = calcSeoScore(originalTags, viralTags, longTailTags, easyRankTags);

    // ── Step 5: Build copy-optimized tag string (≤500 chars) ──────────────
    const topTagsList = [
      ...new Set([
        ...viralTags.slice(0, 8).map((v) => v.tag),
        ...longTailTags.slice(0, 6),
        ...originalTags.slice(0, 6),
      ]),
    ];
    let copyStr = topTagsList.join(", ");
    if (copyStr.length > 500) copyStr = copyStr.slice(0, 497) + "...";

    return res.json({
      mode,
      videoData,
      competitors,
      tags: {
        original: originalTags,
        competitor: [...new Set(competitorTags)].slice(0, 30),
        viral: viralTags,
        longTail: longTailTags,
        easyRank: easyRankTags,
      },
      seoScore,
      copyString: copyStr,
    });
  } catch (err) {
    console.error("Analyze error:", err.message);
    return res.status(500).json({
      error: err?.response?.data?.error?.message || "Server error. Please try again.",
    });
  }
});

/**
 * POST /api/generate-title
 * Body: { tags: string[], currentTitle: string }
 */
app.post("/api/generate-title", async (req, res) => {
  const { tags = [], currentTitle = "" } = req.body;
  const topTags = tags.slice(0, 5).join(", ");
  const suggestions = [
    `How to ${topTags.split(",")[0]?.trim() || "Master This Topic"} – Complete Guide ${new Date().getFullYear()}`,
    `${currentTitle || topTags.split(",")[0]} | Step-by-Step Tutorial for Beginners`,
    `${new Date().getFullYear()} Best Guide: ${topTags.split(",")[0]?.trim() || "Top Strategy"} That Actually Works`,
  ].filter(Boolean);
  res.json({ suggestions });
});

/**
 * POST /api/generate-description
 * Body: { title: string, tags: string[] }
 */
app.post("/api/generate-description", (req, res) => {
  const { title = "Video", tags = [] } = req.body;
  const tagLine = tags.slice(0, 8).join(", ");
  const desc = `In this video, we cover everything you need to know about ${title}.\n\n📌 What you'll learn:\n- ${tags.slice(0, 5).map((t) => `${t}`).join("\n- ")}\n\n🔔 Subscribe for more tips!\n\n#YouTube #SEO ${tags.slice(0, 5).map((t) => `#${t.replace(/\s+/g, "")}`).join(" ")}\n\nTags: ${tagLine}`;
  res.json({ description: desc });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ StepTool backend running on port ${PORT}`);
});

module.exports = app;
