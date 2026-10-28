'use strict';

// Autonomous Screen-Aware Observer for Capri Desktop.
// Periodically and on window change, inspects the desktop screen using a lightweight vision scanner
// (e.g. moondream) and generates witty, in-character spontaneous remarks via Llama 3.2.

const config = require('./config');
const ollama = require('./ollama');
const { captureScreen } = require('./screen');

const MIN_COMMENT_GAP_MS = 40 * 1000; // at least 40s between comments
const CHAT_COOLDOWN_MS = 60 * 1000;   // wait at least 60s after user chats

// Average intervals with random jitter
const FREQ_INTERVALS = {
  chatty:  { min: 45 * 1000, max: 90 * 1000 },   // 45s - 1.5m
  normal:  { min: 120 * 1000, max: 240 * 1000 }, // 2m - 4m
  relaxed: { min: 300 * 1000, max: 600 * 1000 }, // 5m - 10m
};

class VisionObserver {
  constructor() {
    this.timer = null;
    this.windowDebounce = null;
    this.running = false;
    this.lastCommentTime = 0;
    this.lastChatTime = 0;
    this.lastFgWindow = 0;
    this.recentObservations = []; // last 3 observations for deduplication
    this.onComment = null;
    this.getDisplayId = null;
    this.isChatting = () => false;
  }

  start({ onComment, getDisplayId, isChatting } = {}) {
    if (this.running) return;
    this.running = true;
    this.onComment = onComment;
    this.getDisplayId = getDisplayId || (() => null);
    if (typeof isChatting === 'function') this.isChatting = isChatting;

    this.scheduleNext();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    clearTimeout(this.windowDebounce);
    this.timer = null;
    this.windowDebounce = null;
  }

  scheduleNext(delayOverride = null) {
    clearTimeout(this.timer);
    if (!this.running) return;

    const cfg = config.load();
    if (cfg.autoComment === false || cfg.vision === false) {
      // Re-check periodically in case user toggles it back on
      this.timer = setTimeout(() => this.scheduleNext(), 15000);
      return;
    }

    let delay = delayOverride;
    if (delay === null) {
      const preset = FREQ_INTERVALS[cfg.commentFreq] || FREQ_INTERVALS.normal;
      delay = Math.floor(preset.min + Math.random() * (preset.max - preset.min));
    }

    this.timer = setTimeout(() => this.pulse(), Math.max(1000, delay));
  }

  // Called when active window switches (e.g. from VS Code to game or browser)
  notifyWindowChange(fgWindowId) {
    if (!this.running || !fgWindowId || fgWindowId === this.lastFgWindow) return;
    this.lastFgWindow = fgWindowId;

    const now = Date.now();
    // If enough time has passed since last comment, check screen after 4s (lets window render)
    if (now - this.lastCommentTime >= MIN_COMMENT_GAP_MS) {
      clearTimeout(this.windowDebounce);
      this.windowDebounce = setTimeout(() => {
        if (this.running) this.pulse(true);
      }, 4000);
    }
  }

  notifyChatActivity() {
    this.lastChatTime = Date.now();
    this.scheduleNext(CHAT_COOLDOWN_MS);
  }

  async pulse(isWindowTrigger = false, force = false) {
    if (!this.running) return;

    const cfg = config.load();
    if (!force && (cfg.autoComment === false || cfg.vision === false)) {
      this.scheduleNext();
      return;
    }

    const now = Date.now();
    // Don't interrupt if user is actively chatting or commented recently (unless forced)
    if (!force && (this.isChatting() || (now - this.lastChatTime < CHAT_COOLDOWN_MS) || (now - this.lastCommentTime < MIN_COMMENT_GAP_MS))) {
      this.scheduleNext();
      return;
    }

    try {
      // Check if Ollama has vision capability (e.g. moondream installed)
      const installedModels = await ollama.models().catch(() => []);
      if (!ollama.hasVisionCapability(installedModels)) {
        this.scheduleNext();
        return;
      }

      // Step 1: Capture screen (1280x720 JPEG)
      const displayId = this.getDisplayId?.();
      const image = await captureScreen({ displayId });
      if (!image) {
        this.scheduleNext();
        return;
      }

      // Step 2: Optical scan via moondream
      const scanner = installedModels.find((m) => ollama.isScannerModel(m)) ||
                      installedModels.find((m) => ollama.isNativeVisionModel(m));
      if (!scanner) {
        this.scheduleNext();
        return;
      }

      const observation = await ollama.scanScreen(image, scanner);
      if (!observation || observation.length < 10) {
        this.scheduleNext();
        return;
      }

      // Step 3: Deduplication check (avoid saying same thing twice in a row)
      if (!force && this.isTooSimilar(observation) && !isWindowTrigger) {
        this.scheduleNext();
        return;
      }
      this.recentObservations.push(observation);
      if (this.recentObservations.length > 5) this.recentObservations.shift();

      // Step 4: Generate Capri's spontaneous dialogue via Llama 3.2
      const conversationalModel = installedModels.find((m) => !ollama.isScannerModel(m)) || installedModels[0];
      const comment = await this.generateComment(conversationalModel, observation, cfg.lang);

      if (comment && comment.length > 5) {
        this.lastCommentTime = Date.now();
        const mood = this.determineMood(comment, observation);
        this.onComment?.({ text: comment, mood, observation });
      }
    } catch (err) {
      console.warn('[capri:observer] pulse error:', err.message);
    } finally {
      this.scheduleNext();
    }
  }

  isTooSimilar(current) {
    if (!this.recentObservations.length) return false;
    const last = this.recentObservations[this.recentObservations.length - 1];
    const wordsCurr = new Set(current.toLowerCase().match(/\b\w{4,}\b/g) || []);
    const wordsLast = new Set(last.toLowerCase().match(/\b\w{4,}\b/g) || []);
    if (!wordsCurr.size || !wordsLast.size) return false;

    let overlap = 0;
    for (const w of wordsCurr) {
      if (wordsLast.has(w)) overlap++;
    }
    const ratio = overlap / Math.min(wordsCurr.size, wordsLast.size);
    return ratio > 0.72; // over 72% identical keywords
  }

  async generateComment(model, observation, userLang = 'auto') {
    const lang = userLang === 'auto' ? 'the user\'s language (e.g. Indonesian or English)' : userLang;
    const hour = new Date().getHours();
    const timeInfo = (hour >= 1 && hour <= 5) ? `[Local time: ${hour}:00 late night / dini hari. If relevant, tease them playfully about being awake late]` : '';

    const systemPrompt = [
      'You are Capri, the personality construct from Project Capricorn (Cyberpunk: Edgerunners, season 2).',
      'You live on the user\'s desktop as a small glitchy digital companion.',
      'How you talk: playful, mischievous, teasing, witty, sharp cyberpunk anime attitude. Use Night City slang (choom, nova, preem, gonk, flatline) naturally now and then.',
      timeInfo,
      'Right now, your optic scanner observes the user\'s computer screen:',
      `[Screen observation: ${observation}]`,
      `Task: Make ONE short, spontaneous, witty remark reacting to what they are doing on their screen right now (coding, debugging, playing a game, browsing, reading, watching videos, writing).`,
      'Rules:',
      `- 1 single sentence only (maximum 25 words).`,
      `- Answer in ${lang}.`,
      `- Speak directly to the user in character. NEVER say "The image shows", "The screen depicts", "I see a", or describe the image generically.`,
      `- Plain text only, no emojis, no quotes, no markdown.`,
    ].filter(Boolean).join('\n');

    let response = '';
    const text = await ollama.chat(
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Say one spontaneous comment about what you see on my screen right now.' },
        ],
      },
      (piece) => { response += piece; }
    ).catch(() => '');

    return this.clean(text || response);
  }

  clean(text) {
    return String(text || '')
      .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
      .replace(/\[\[[^\]]*(\]\]|$)/g, '')
      .replace(/^(the image (features|shows|depicts|displays|presents|is of)|this is a screenshot of|in this (image|screenshot),?)\s*/i, '')
      .replace(/^['"“]+|['"”]+$/g, '')
      .replace(/[*_`#"]+/g, '')
      .replace(/\s*\n\s*/g, ' ')
      .trim();
  }

  determineMood(text, observation = '') {
    const obs = String(observation || '').toLowerCase();
    const txt = String(text || '').toLowerCase();
    const hour = new Date().getHours();

    // 1. Errors, bugs, or crashes -> wide (surprised) or laugh
    if (/(error|traceback|exception|crash|failed|syntaxerror|typeerror)/i.test(obs) || /(error|rusak|meledak|bug|crash|flatline)/i.test(txt)) {
      return /(ha){2,}|lol|wkwk|haha/i.test(txt) ? 'laugh' : 'wide';
    }
    // 2. Gaming -> smug
    if (/(game|steam|valorant|cyberpunk|dota|epic games|fps|player|gaming)/i.test(obs)) {
      return 'smug';
    }
    // 3. Late night (01:00 - 05:00) -> aside
    if (hour >= 1 && hour <= 5) {
      return 'aside';
    }
    // 4. Browser / Media -> smug
    if (/(youtube|twitch|video|netflix|twitter|reddit|browser|chrome|firefox)/i.test(obs)) {
      return 'smug';
    }
    // 5. Speech-based moods
    if (/(ha){2,}|lol|jaja|wkwk|haha/i.test(txt)) return 'laugh';
    if (txt.includes('!')) return 'grin';
    if (txt.includes('?')) return 'smug';
    return 'look';
  }

  async triggerNow() {
    return this.pulse(true, true);
  }
}

module.exports = new VisionObserver();
