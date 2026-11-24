import express from "express";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ─── Trust Vercel's proxy so express-rate-limit can read the real client IP ──
// Without this, all requests appear to come from the same proxy IP and
// rate-limit will throw an ERR_ERL_PERMISSIVE_TRUST_PROXY / block everyone.
app.set("trust proxy", 1);

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json());

// Serve static files only when running locally (Vercel handles this via vercel.json)
if (process.env.NODE_ENV !== "production") {
  app.use(express.static(path.join(__dirname, "..", "public")));
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,                   // 30 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please wait a few minutes before trying again.",
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extracts a numeric Tweet ID from any x.com or twitter.com URL.
 * Supports:
 *   https://twitter.com/user/status/1234567890
 *   https://x.com/user/status/1234567890
 *   https://x.com/i/web/status/1234567890
 */
function extractTweetId(url) {
  try {
    const u = new URL(url.trim());
    if (!["twitter.com", "x.com"].includes(u.hostname.replace("www.", ""))) {
      return null;
    }
    const match = u.pathname.match(/\/status(?:es)?\/(\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Fetches tweet data from X's public syndication API.
 * Returns the full JSON object or throws on failure.
 * This is a pure metadata call — no large file proxy streaming —
 * so it reliably finishes well within Vercel's 10-second timeout.
 */
async function fetchTweetData(tweetId) {
  const syndicationUrl =
    `https://cdn.syndication.twimg.com/tweet-result` +
    `?id=${tweetId}` +
    `&lang=en` +
    `&features=tfw_timeline_list%3A%3Btfw_follower_count_sunset%3Atrue%3Btfw_tweet_edit_backend%3Aon%3Btfw_refsrc_session%3Aon%3Btfw_fosnr_soft_interventions_enabled%3Aon%3Btfw_show_birdwatch_pivots_enabled%3Aon%3Btfw_show_business_verified_badge%3Aon%3Btfw_duplicate_scribes_to_settings%3Aon%3Btfw_use_profile_image_shape_enabled%3Aon%3Btfw_show_govt_verified_badge%3Aon%3Btfw_unified_cards_iframe_fetch_enabled%3Aon%3Btfw_frames_enabled%3Aon%3Btfw_video_hls_dynamic_manifests_enabled%3Atrue_bitrate%3Btfw_legacy_timeline_sunset%3Atrue%3Btfw_tweet_edit_frontend%3Aon` +
    `&token=4c2mmul6mnh`;

  const res = await fetch(syndicationUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
      Referer: "https://platform.twitter.com/",
      Origin: "https://platform.twitter.com",
    },
  });

  if (!res.ok) {
    if (res.status === 404) throw new Error("Tweet not found or is private.");
    if (res.status === 429)
      throw new Error("Twitter rate-limited us. Please try again later.");
    throw new Error(`Twitter API responded with status ${res.status}.`);
  }

  return res.json();
}

/**
 * Walks the tweet data to find MP4 video variants.
 * Returns an array of { url, bitrate, contentType, quality }
 * sorted descending by bitrate (highest quality first).
 *
 * Only returns direct video.twimg.com MP4 URLs — never HLS/m3u8 —
 * so the browser can load and download them without any proxy.
 */
function extractVideoVariants(tweetData) {
  const mediaPaths = [
    tweetData?.video?.variants,
    tweetData?.mediaDetails?.[0]?.video_info?.variants,
    tweetData?.extended_entities?.media?.[0]?.video_info?.variants,
    tweetData?.entities?.media?.[0]?.video_info?.variants,
  ];

  for (const variants of mediaPaths) {
    if (!Array.isArray(variants)) continue;

    const mp4Variants = variants
      .filter(
        (v) =>
          v.content_type === "video/mp4" &&
          typeof v.url === "string" &&
          v.url.includes("video.twimg.com") // guarantee direct CDN URLs only
      )
      .map((v) => ({
        url: v.url,
        bitrate: v.bitrate ?? 0,
        contentType: v.content_type,
        quality: bitrateToLabel(v.bitrate ?? 0),
      }))
      .sort((a, b) => b.bitrate - a.bitrate);

    if (mp4Variants.length > 0) return mp4Variants;
  }

  return [];
}

function bitrateToLabel(bitrate) {
  if (bitrate >= 2_000_000) return "1080p";
  if (bitrate >= 1_000_000) return "720p";
  if (bitrate >= 500_000) return "480p";
  if (bitrate >= 200_000) return "360p";
  if (bitrate > 0) return "Low";
  return "MP4";
}

/**
 * Extracts the best available thumbnail URL from tweet data.
 */
function extractThumbnail(tweetData) {
  return (
    tweetData?.video?.poster ??
    tweetData?.mediaDetails?.[0]?.media_url_https ??
    tweetData?.extended_entities?.media?.[0]?.media_url_https ??
    tweetData?.entities?.media?.[0]?.media_url_https ??
    null
  );
}

// ─── POST /api/fetch-video ───────────────────────────────────────────────────
// Returns JSON metadata only (direct MP4 URLs + thumbnail).
// Downloads are handled via /api/download (server-side proxy) so the browser
// never makes a direct request to video.twimg.com (which blocks non-Twitter referers).
app.post("/api/fetch-video", apiLimiter, async (req, res) => {
  const { url } = req.body ?? {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "A tweet URL is required." });
  }

  const tweetId = extractTweetId(url);
  if (!tweetId) {
    return res.status(400).json({
      error:
        "Invalid URL. Please paste a valid x.com or twitter.com tweet link.",
    });
  }

  try {
    const tweetData = await fetchTweetData(tweetId);
    const variants = extractVideoVariants(tweetData);

    if (variants.length === 0) {
      return res.status(422).json({
        error:
          "This tweet doesn't contain a downloadable MP4 video. Only direct MP4 videos are supported.",
      });
    }

    const thumbnail = extractThumbnail(tweetData);
    const author =
      tweetData?.user?.name ??
      tweetData?.core?.user_results?.result?.legacy?.name ??
      "Unknown";
    const username =
      tweetData?.user?.screen_name ??
      tweetData?.core?.user_results?.result?.legacy?.screen_name ??
      "";
    const text = tweetData?.text ?? "";

    return res.json({
      tweetId,
      author,
      username,
      text,
      thumbnail,
      variants, // sorted highest → lowest bitrate; all are direct video.twimg.com URLs
    });
  } catch (err) {
    console.error(`[fetch-video] ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/download ───────────────────────────────────────────────────────
// Server-side proxy that fetches the MP4 from Twitter's CDN and streams it
// back to the browser with Content-Disposition: attachment.
//
// WHY: video.twimg.com returns 403 when the browser sends a non-Twitter Referer
// header (e.g. localhost:3000 or your Vercel domain). By proxying through our
// own server we can set Referer: https://twitter.com/ and the CDN allows the
// request. The browser only ever talks to our same-origin server, so there are
// no CORS issues and the Save dialog always appears.
app.get("/api/download", apiLimiter, async (req, res) => {
  const { url, quality } = req.query;

  // Strict allowlist: only proxy video.twimg.com MP4 URLs
  if (
    !url ||
    typeof url !== "string" ||
    !url.startsWith("https://video.twimg.com/") ||
    !url.includes(".mp4")
  ) {
    return res.status(400).json({ error: "Invalid or disallowed video URL." });
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
        // This is the key fix: Twitter CDN requires a twitter.com Referer.
        // Browser requests from our domain get 403; server-side requests pass.
        Referer: "https://twitter.com/",
        Origin: "https://twitter.com",
        Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
      },
    });

    if (!upstream.ok) {
      return res
        .status(upstream.status)
        .json({ error: `Twitter CDN responded with ${upstream.status}.` });
    }

    // Build a clean filename: xvault_1080p_<timestamp>.mp4
    const safeQuality = /^[a-zA-Z0-9]+$/.test(quality ?? "") ? quality : "video";
    const filename = `xvault_${safeQuality}_${Date.now()}.mp4`;

    // Forward essential headers so the browser knows the file size / type
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    if (upstream.headers.get("content-length")) {
      res.setHeader("Content-Length", upstream.headers.get("content-length"));
    }
    // Allow the browser to show download progress
    res.setHeader("Transfer-Encoding", "chunked");

    // Stream the response — no buffering, so we don't hold the whole file in RAM
    upstream.body.pipe(res);

    // If the client disconnects mid-download, destroy the upstream to free resources
    req.on("close", () => upstream.body.destroy());
  } catch (err) {
    console.error(`[download] ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "Download proxy failed: " + err.message });
    }
  }
});

// ─── Catch-all (local dev only) ──────────────────────────────────────────────
// On Vercel, the catch-all is handled by vercel.json routing public/index.html.
if (process.env.NODE_ENV !== "production") {
  app.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });
}

// ─── Local dev server ────────────────────────────────────────────────────────
// app.listen() is intentionally NOT called in production so Vercel can
// import this module as a pure serverless function handler.
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(
      `\n🚀  Tweet Video Downloader running at http://localhost:${PORT}\n`
    );
  });
}

// ─── Vercel Serverless Export ─────────────────────────────────────────────────
export default app;
