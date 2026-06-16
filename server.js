const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const ACR_HOST = process.env.ACR_HOST;
const ACR_KEY = process.env.ACR_KEY;
const ACR_SECRET = process.env.ACR_SECRET;

function buildAcrSignature() {
  const timestamp = Math.floor(Date.now() / 1000);
  const stringToSign = `POST\n/v1/identify\n${ACR_KEY}\naudio\n1\n${timestamp}`;
  const signature = crypto.createHmac('sha1', ACR_SECRET).update(stringToSign).digest('base64');
  return { signature, timestamp };
}

function isValidTikTokUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('tiktok.com') || parsed.hostname.includes('vm.tiktok.com');
  } catch(e) {
    return false;
  }
}

function ytDlpAvailable() {
  try {
    execSync('yt-dlp --version', { stdio: 'ignore' });
    return true;
  } catch(e) {
    return false;
  }
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    ytdlp: ytDlpAvailable(),
    acr_configured: !!(ACR_HOST && ACR_KEY && ACR_SECRET)
  });
});

app.post('/identify', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'Please paste a TikTok URL.' });
  }

  if (!isValidTikTokUrl(url.trim())) {
    return res.status(400).json({ error: 'Only TikTok URLs are supported right now.' });
  }

  if (!ACR_HOST || !ACR_KEY || !ACR_SECRET) {
    return res.status(500).json({ error: 'Music recognition service is not configured yet.' });
  }

  if (!ytDlpAvailable()) {
    return res.status(500).json({ error: 'Audio extraction tool is not available on this server.' });
  }

  const tmpFile = path.join('/tmp', `audio_${Date.now()}.mp3`);

  try {
    console.log(`[identify] Downloading audio from: ${url}`);
    execSync(
      `yt-dlp -x --audio-format mp3 --audio-quality 5 -o "${tmpFile}" --no-playlist "${url.trim()}"`,
      { timeout: 30000, stdio: 'pipe' }
    );
  } catch(err) {
    console.error('[identify] yt-dlp error:', err.message);
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    return res.status(422).json({ error: "Couldn't download this video. Make sure it's a public TikTok and try again." });
  }

  if (!fs.existsSync(tmpFile)) {
    console.error('[identify] Audio file not found after yt-dlp ran');
    return res.status(422).json({ error: "No audio file was produced. The video may have no audio track." });
  }

  const stats = fs.statSync(tmpFile);
  console.log(`[identify] Audio file size: ${stats.size} bytes`);

  if (stats.size === 0) {
    fs.unlinkSync(tmpFile);
    return res.status(422).json({ error: "Audio file is empty. The video may have no audio track." });
  }

  let audioBuffer;
  try {
    audioBuffer = fs.readFileSync(tmpFile);
  } catch(err) {
    console.error('[identify] Failed to read audio file:', err.message);
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    return res.status(500).json({ error: 'Failed to read audio file.' });
  }

  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);

  const { signature, timestamp } = buildAcrSignature();
  const form = new FormData();
  form.append('sample', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
  form.append('access_key', ACR_KEY);
  form.append('data_type', 'audio');
  form.append('signature_version', '1');
  form.append('signature', signature);
  form.append('timestamp', String(timestamp));
  form.append('sample_bytes', String(audioBuffer.length));

  let acrResponse;
  try {
    console.log(`[identify] Sending to ACRCloud: ${ACR_HOST}`);
    acrResponse = await axios.post(`https://${ACR_HOST}/v1/identify`, form, {
      headers: form.getHeaders(),
      timeout: 20000
    });
  } catch(err) {
    console.error('[identify] ACRCloud request error:', err.message);
    return res.status(502).json({ error: 'Music recognition service failed. Please try again.' });
  }

  console.log('[identify] ACRCloud response status:', acrResponse.data?.status);

  const acrData = acrResponse.data;

  if (!acrData || !acrData.status) {
    console.error('[identify] Unexpected ACRCloud response shape:', JSON.stringify(acrData));
    return res.status(502).json({ error: 'Unexpected response from recognition service.' });
  }

  if (acrData.status.code !== 0) {
    console.log('[identify] No match. ACR status:', acrData.status);
    return res.json({
      identified: false,
      message: "Couldn't identify the song. Try a video where the music is clearly audible."
    });
  }

  const music = acrData.metadata?.music?.[0];
  if (!music) {
    console.error('[identify] Match returned but no music metadata:', JSON.stringify(acrData));
    return res.json({ identified: false, message: "Song detected but metadata was missing." });
  }

  const result = {
    identified: true,
    song: music.title || 'Unknown',
    artist: music.artists?.map(a => a.name).join(', ') || 'Unknown',
    album: music.album?.name || null,
    year: music.release_date?.split('-')[0] || null,
    genre: music.genres?.[0]?.name || null,
    score: music.score || null
  };

  console.log('[identify] Result:', JSON.stringify(result));
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
