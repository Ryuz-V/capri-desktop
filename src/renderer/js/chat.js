// Talking to her: you type in her panel, and a local model (Ollama, from the main process) answers
// as her, in writing. The replies are AI-generated, and the panel says so on every chat.
// Ask her to close an app and she will (Windows): she spots it in what you wrote (or the model names
// it with a tag in its answer), and immediately flatlines/closes it.

import { pick, fmt } from './util.js';

const REMEMBER = 12; // messages of this conversation she keeps in mind
const LANGUAGE = { fr: 'French', en: 'English', es: 'Spanish', pt: 'Brazilian Portuguese', ru: 'Russian' };
const STAY_MS = 10 * 60 * 1000; // no wandering off mid-conversation
const LOADING_AFTER_MS = 5000;
const CLOSE_TAG = /\[\[\s*close\s*:?\s*([^\]]*)\]\]/i; // [[close: AM Music]] at the end of her answer
// "close", "shut down", "ferme", "quitte", "cierra", "fecha", "закрой", "tutup"... in any of her languages
const CLOSE_ASK = /\b(close|shut|quit|kill|exit|tutup|matiin|matikan|hentikan)|ferm|quitt|coupe|arr[êe]t|cierr|cerra|fech|закр|выключ/i;
// Keywords asking her to inspect/look at the screen
const SCREEN_ASK = /\b(lihat|liat|tengok|pandang|nengok|baca|cek|periksa|analisis|layar|monitor|tampilan|desktop|jendela|screen|display|monitor|look|see|watch|view|inspect|read|check|spot|glance|error|bug|crash|masalah|code|kode|terminal|console|ide|window)\b/i;

export class Chat {
  constructor({ capri, panel, voice, host, brain }) {
    this.capri = capri;
    this.panel = panel;
    this.voice = voice;
    this.host = host;
    this.brain = brain;
    this.history = []; // this run's conversation, [{ role, content }]
    this.open = false;
    this.turn = 0;     // id of the answer coming in, if any
    this.answer = '';
    this.apps = [];    // the apps open on this PC, as last listed: [{ name, label }]
    this.appsReady = Promise.resolve();
    this.visionEnabled = true;
    this.hasVisionModel = false;
    this.modelTag = '';
    this.audioStream = null;
    this.audioCtx = null;
    this.processorNode = null;
    this.audioChunks = [];
    this.audioSampleRate = 16000;
    this.recording = false;
    this.maxRecTimer = 0;
    this.hasSpoken = false;
    this.lastSpoke = 0;
    this.voiceMode = false;
    this.voiceLoopTimer = null;
    this.consecutiveSilences = 0;
    host.onChatDelta(({ id, text }) => this.onDelta(id, text));
  }

  get t() {
    return this.brain.t.chat;
  }

  async start() {
    const { capri, host, t } = this;
    if (this.open) {
      this.panel.chatInput.focus();
      return;
    }
    if (capri.stowed) {
      host.setConfig({ visible: true });
      await capri.unstow();
    }
    capri.wake();
    const status = await host.chatStatus();
    if (!status.ok) {
      // no Ollama, or nothing to talk with yet: what to do about it
      const offline = status.error === 'offline';
      capri.perform('curious', capri.towardCenter());
      this.panel.say({
        kind: 'info',
        face: 'aside',
        guide: true,
        line: offline ? t.offline : t.noModel,
        quote: offline ? t.offlineHow : t.noModelHow,
        actions: offline
          ? [{ id: 'get', label: t.getOllama, primary: true }, { id: 'ok', label: t.ok }]
          : [{ id: 'ok', label: t.ok, primary: true }],
        onAction: (id) => {
          if (id === 'get') host.openOllama();
          this.panel.hide();
        },
        hold: null,
      });
      return;
    }
    this.listApps();
    this.hasVisionModel = Boolean(status.isVision);
    this.modelTag = status.model ? status.model.replace(/:latest$/, '') : '';
    const cfg = await host.getConfig();
    this.visionEnabled = cfg.vision !== false;
    host.focusOverlay(true); // the keyboard, for typing to her
    const shown = this.panel.say({
      kind: 'chat',
      face: 'look',
      badge: t.badge,
      tag: (status.isVision ? '👁 ' : '') + this.modelTag,
      line: pick(this.history.length ? t.again : t.hello),
      chat: {
        placeholder: t.placeholder,
        send: t.send,
        close: t.close,
        noteTag: t.noteTag,
        note: t.note,
      },
      onVoice: () => this.toggleVoice(),
      onSend: (text) => this.send(text),
      onLeave: () => this.close(),
      hold: null,
    });
    if (!shown) {
      host.focusOverlay(false); // something more important is on (a permission prompt)
      return;
    }
    this.open = true;
    setTimeout(() => this.panel.chatInput.focus(), 150); // once the overlay has the keyboard
    capri.perform('hop');
    capri.nextMove = capri.nextGaze = performance.now() + STAY_MS;
  }

  async startVoice() {
    const { capri, host, t } = this;
    if (this.turn) return;

    if (this.open) {
      this.close();
    }

    if (capri.stowed) {
      host.setConfig({ visible: true });
      await capri.unstow();
    }
    capri.wake();

    const status = await host.chatStatus();
    if (!status.ok) {
      const offline = status.error === 'offline';
      capri.perform('curious', capri.towardCenter());
      this.panel.say({
        kind: 'info',
        face: 'aside',
        guide: true,
        line: offline ? t.offline : t.noModel,
        quote: offline ? t.offlineHow : t.noModelHow,
        actions: offline
          ? [{ id: 'get', label: t.getOllama, primary: true }, { id: 'ok', label: t.ok }]
          : [{ id: 'ok', label: t.ok, primary: true }],
        onAction: (id) => {
          if (id === 'get') host.openOllama();
          this.panel.hide();
        },
        hold: null,
      });
      return;
    }

    this.listApps();
    this.hasVisionModel = Boolean(status.isVision);
    this.modelTag = status.model ? status.model.replace(/:latest$/, '') : '';
    const cfg = await host.getConfig();
    this.visionEnabled = cfg.vision !== false;

    this.voiceMode = true;
    this.consecutiveSilences = 0;
    this.resumeVoiceListening();
  }

  resumeVoiceListening() {
    if (!this.voiceMode || this.turn || this.open) return;
    clearTimeout(this.voiceLoopTimer);

    const { capri, t } = this;
    capri.perform('curious', capri.towardCenter());

    this.panel.say({
      kind: 'optic',
      face: 'curious',
      badge: 'VOICE · REC',
      tag: (this.hasVisionModel ? '👁 ' : '') + this.modelTag,
      line: t.voiceListening || 'Listening… Speak to me, choom.',
      voice: true,
      actions: [
        { id: 'stop_voice', label: t.stopVoice || '🛑 Stop listening', primary: false },
      ],
      onAction: (id) => {
        if (id === 'stop_voice') this.stopVoiceMode();
      },
      onLeave: () => {
        if (this.voiceMode && (this.panel.leaving || !this.panel.visible)) {
          this.stopListening({ transcribe: false });
          this.voiceMode = false;
        }
      },
      hold: null,
    });

    this.startListening();
  }

  stopVoiceMode() {
    clearTimeout(this.voiceLoopTimer);
    clearTimeout(this.maxRecTimer);
    this.voiceMode = false;
    this.consecutiveSilences = 0;
    this.stopListening({ transcribe: false });

    if (this.turn) {
      this.host.chatStop(this.turn);
      this.turn = 0;
    }
    this.answer = '';

    if (this.panel.current) {
      this.panel.current.voice = false;
    }

    this.panel.line.classList.remove('is-streaming');
    this.panel.setActions([]);

    this.panel.say({
      kind: 'idle',
      face: 'aside',
      badge: 'IDLE',
      line: this.t.voiceBye || 'Catch you later, choom.',
      hold: 2000,
      force: true,
    });
  }

  toggleVoice() {
    if (this.turn) return;
    if (this.voiceMode) {
      this.stopVoiceMode();
    } else if (this.open) {
      if (this.recording) this.stopListening({ transcribe: true });
      else this.startListening();
    } else {
      this.startVoice();
    }
  }

  async startListening() {
    if (this.recording || this.turn || (!this.open && !this.voiceMode)) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      if ((!this.voiceMode && !this.open) || this.turn) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioContextClass();
      const sampleRate = audioCtx.sampleRate;
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);

      this.audioStream = stream;
      this.audioCtx = audioCtx;
      this.processorNode = processor;
      this.audioChunks = [];
      this.audioSampleRate = sampleRate;
      this.recording = true;
      this.hasSpoken = false;
      this.lastSpoke = 0;

      if (this.open) {
        this.panel.setChatListening(true, this.t.listening || 'Listening… (speak now)');
      }
      this.capri.perform('hop');

      processor.onaudioprocess = (e) => {
        if (!this.recording) return;
        const input = e.inputBuffer.getChannelData(0);
        this.audioChunks.push(new Float32Array(input));

        // Detect voice volume (RMS)
        let sum = 0;
        for (let i = 0; i < input.length; i++) {
          sum += input[i] * input[i];
        }
        const rms = Math.sqrt(sum / input.length);

        if (rms > 0.025) {
          this.hasSpoken = true;
          this.lastSpoke = performance.now();
        } else if (this.hasSpoken && performance.now() - this.lastSpoke > 1500) {
          // Silence after user spoke: auto stop & transcribe
          this.stopListening({ transcribe: true });
        }
      };

      const muteGain = audioCtx.createGain();
      muteGain.gain.value = 0;
      source.connect(processor);
      processor.connect(muteGain);
      muteGain.connect(audioCtx.destination);

      clearTimeout(this.maxRecTimer);
      this.maxRecTimer = setTimeout(() => {
        if (this.recording) this.stopListening({ transcribe: true });
      }, 12000);
    } catch (err) {
      console.warn('[capri:chat] microphone error:', err);
      this.stopListening({ transcribe: false });
      if (this.voiceMode) {
        this.voiceMode = false;
        this.panel.say({
          kind: 'info',
          face: 'aside',
          line: 'Microphone not accessible. Check permissions.',
          hold: 4000,
        });
      } else if (this.open) {
        this.panel.setChatListening(false);
        this.panel.chatInput.placeholder = 'Microphone not accessible';
        setTimeout(() => {
          if (this.open && !this.turn) this.panel.chatInput.placeholder = this.t.placeholder;
        }, 3500);
      }
    }
  }

  async stopListening({ transcribe = true } = {}) {
    if (!this.recording && !this.audioStream) return;
    this.recording = false;
    clearTimeout(this.maxRecTimer);

    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      try { this.processorNode.disconnect(); } catch (_) {}
      this.processorNode = null;
    }
    if (this.audioStream) {
      this.audioStream.getTracks().forEach((track) => track.stop());
      this.audioStream = null;
    }
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch (_) {}
      this.audioCtx = null;
    }

    if (!transcribe || (!this.open && !this.voiceMode)) {
      this.panel.setChatListening(false);
      this.audioChunks = [];
      return;
    }

    let totalSamples = 0;
    for (const chunk of this.audioChunks) totalSamples += chunk.length;

    const minSamples = Math.floor(this.audioSampleRate * 0.4);
    if (totalSamples < minSamples || !this.hasSpoken) {
      this.audioChunks = [];
      if (this.voiceMode) {
        this.consecutiveSilences = (this.consecutiveSilences || 0) + 1;
        if (this.consecutiveSilences >= 3) {
          this.stopVoiceMode();
          return;
        }
        this.panel.say({
          kind: 'optic',
          face: 'aside',
          badge: 'VOICE · REC',
          tag: (this.hasVisionModel ? '👁 ' : '') + this.modelTag,
          line: this.t.voiceLost || 'Couldn’t catch that, choom. Speak again?',
          voice: true,
          actions: [
            { id: 'stop_voice', label: this.t.stopVoice || '🛑 Stop listening', primary: false },
          ],
          onAction: (id) => {
            if (id === 'stop_voice') this.stopVoiceMode();
          },
          onLeave: () => {
            if (this.voiceMode && (this.panel.leaving || !this.panel.visible)) {
              this.stopListening({ transcribe: false });
              this.voiceMode = false;
            }
          },
          hold: null,
        });
        clearTimeout(this.voiceLoopTimer);
        this.voiceLoopTimer = setTimeout(() => {
          if (this.voiceMode && !this.turn && !this.open) {
            this.resumeVoiceListening();
          }
        }, 1800);
      } else {
        this.panel.setChatListening(false);
      }
      return;
    }

    this.consecutiveSilences = 0;

    if (this.voiceMode) {
      this.panel.say({
        kind: 'optic',
        face: 'aside',
        badge: 'DECODING',
        tag: 'VOICE LINK',
        line: this.t.transcribing || 'Transcribing speech…',
        voice: true,
        actions: [
          { id: 'stop_voice', label: this.t.stopVoice || '🛑 Stop listening', primary: false },
        ],
        onAction: (id) => {
          if (id === 'stop_voice') this.stopVoiceMode();
        },
        onLeave: () => {
          if (this.voiceMode && (this.panel.leaving || !this.panel.visible)) {
            this.stopListening({ transcribe: false });
            this.voiceMode = false;
          }
        },
        hold: null,
      });
    } else {
      this.panel.setChatListening(false, this.t.transcribing || 'Transcribing speech…');
      this.panel.setChatBusy(true);
    }

    const merged = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of this.audioChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.audioChunks = [];

    const wavBytes = encodeWav(merged, this.audioSampleRate);
    const wavBase64 = uint8ToBase64(wavBytes);

    const lang = this.brain.lang === 'id' ? 'id-ID' : (this.brain.lang === 'fr' ? 'fr-FR' : (this.brain.lang === 'es' ? 'es-ES' : (this.brain.lang === 'pt' ? 'pt-BR' : (this.brain.lang === 'ru' ? 'ru-RU' : 'id-ID'))));

    try {
      const res = await this.host.transcribeSpeech({ wavBase64, lang });
      if (!this.voiceMode && !this.open) return;

      if (res?.ok && res.text?.trim()) {
        const spoken = res.text.trim();
        if (this.voiceMode) {
          await this.sendVoice(spoken);
        } else if (this.open) {
          this.panel.chatInput.value = spoken;
          this.panel.setChatBusy(false);
          this.panel.setChatListening(false);
          this.send(spoken);
        }
      } else {
        if (this.voiceMode) {
          this.panel.say({
            kind: 'optic',
            face: 'aside',
            badge: 'VOICE · REC',
            tag: (this.hasVisionModel ? '👁 ' : '') + this.modelTag,
            line: this.t.voiceLost || 'Couldn’t catch that, choom. Speak again?',
            voice: true,
            actions: [
              { id: 'stop_voice', label: this.t.stopVoice || '🛑 Stop listening', primary: false },
            ],
            onAction: (id) => {
              if (id === 'stop_voice') this.stopVoiceMode();
            },
            onLeave: () => {
              if (this.voiceMode && (this.panel.leaving || !this.panel.visible)) {
                this.stopListening({ transcribe: false });
                this.voiceMode = false;
              }
            },
            hold: null,
          });
          clearTimeout(this.voiceLoopTimer);
          this.voiceLoopTimer = setTimeout(() => {
            if (this.voiceMode && !this.turn && !this.open) {
              this.resumeVoiceListening();
            }
          }, 2000);
        } else {
          this.panel.setChatBusy(false);
          this.panel.setChatListening(false);
          this.panel.setFace('aside');
          const errText = res?.error || (this.brain.lang === 'en' ? 'Couldn\'t catch that, choom...' : 'Suara kurang jelas, coba lagi...');
          this.panel.chatInput.placeholder = errText;
          setTimeout(() => {
            if (this.open && !this.turn) this.panel.chatInput.placeholder = this.t.placeholder;
          }, 3500);
        }
      }
    } catch (err) {
      console.warn('[capri:chat] transcribe error:', err);
      if (this.voiceMode) {
        this.panel.say({
          kind: 'optic',
          face: 'aside',
          badge: 'VOICE · REC',
          tag: (this.hasVisionModel ? '👁 ' : '') + this.modelTag,
          line: this.t.voiceLost || 'Couldn’t catch that, choom. Speak again?',
          voice: true,
          actions: [
            { id: 'stop_voice', label: this.t.stopVoice || '🛑 Stop listening', primary: false },
          ],
          onAction: (id) => {
            if (id === 'stop_voice') this.stopVoiceMode();
          },
          onLeave: () => {
            if (this.voiceMode && (this.panel.leaving || !this.panel.visible)) {
              this.stopListening({ transcribe: false });
              this.voiceMode = false;
            }
          },
          hold: null,
        });
        clearTimeout(this.voiceLoopTimer);
        this.voiceLoopTimer = setTimeout(() => {
          if (this.voiceMode && !this.turn && !this.open) {
            this.resumeVoiceListening();
          }
        }, 2000);
      } else {
        this.panel.setChatBusy(false);
        this.panel.setChatListening(false);
      }
    }
  }

  async sendVoice(text) {
    if (this.turn) return;
    const id = Date.now();
    this.turn = id;
    this.answer = '';

    const wantsScreen = SCREEN_ASK.test(text) && this.visionEnabled && this.hasVisionModel;
    let screenshot = null;

    if (wantsScreen) {
      this.voice.play('scan');
      this.capri.pulse();
      const res = await this.host.captureScreen().catch(() => null);
      if (res?.ok && res.image) {
        screenshot = res.image;
      }
    }

    const userTurn = { role: 'user', content: text };
    if (screenshot) userTurn.images = [screenshot];
    this.history.push(userTurn);

    this.panel.chatTurn({
      quote: text,
      face: screenshot ? 'look' : 'aside',
      badge: this.t.badge || 'AI · LIVE',
      tag: (this.hasVisionModel ? '👁 ' : '') + this.modelTag,
    });
    this.panel.setActions([
      { id: 'stop_voice', label: this.t.stopVoice || '🛑 Stop listening', primary: false },
    ], (actionId) => {
      if (actionId === 'stop_voice') this.stopVoiceMode();
    });

    this.capri.pulse();
    await Promise.race([this.appsReady, new Promise((r) => setTimeout(r, 1500))]);

    const recent = this.history.slice(-REMEMBER).map((m, idx, arr) => {
      if (m.images && idx !== arr.length - 1) {
        const { images, ...rest } = m;
        return rest;
      }
      return m;
    });

    const messages = [{ role: 'system', content: this.persona(Boolean(screenshot)) }, ...recent];
    const slow = setTimeout(() => {
      if (this.turn === id && !this.answer) this.panel.stream(this.t.loading);
    }, LOADING_AFTER_MS);

    const res = await this.host.chatSend({ id, messages });
    clearTimeout(slow);

    if (this.turn !== id) {
      if (this.history.at(-1)?.content === text) this.history.pop();
      return;
    }
    this.turn = 0;

    if (!this.voiceMode) return;

    if (!res.ok) {
      this.history.pop();
      this.panel.setFace('wide');
      this.panel.stream(`${this.t.failed} ${res.error}`, { done: true });
      clearTimeout(this.voiceLoopTimer);
      this.voiceLoopTimer = setTimeout(() => {
        if (this.voiceMode && !this.turn && !this.open) this.resumeVoiceListening();
      }, 4000);
      return;
    }

    const answer = clean(res.text) || '…';
    this.history.push({ role: 'assistant', content: answer });
    this.panel.stream(answer, { done: true });
    this.panel.setFace(mood(answer));

    const wanted = this.askedToClose(text) || tagged(res.text);
    if (wanted) {
      this.offerClose(wanted, answer);
    } else {
      this.panel.setActions([
        { id: 'speak_now', label: this.t.speak || '🎙️ Speak to me', primary: true },
        { id: 'stop_voice', label: this.t.stopVoice || '🛑 Stop listening', primary: false },
      ], (actionId) => {
        if (actionId === 'speak_now') this.resumeVoiceListening();
        else if (actionId === 'stop_voice') this.stopVoiceMode();
      });
    }

    if (this.panel.current) {
      this.panel.current.onClick = () => {
        if (this.voiceMode && !this.turn && !this.open) {
          this.resumeVoiceListening();
        }
      };
    }

    this.listApps();

    // Auto-return to listening state after the user has time to read Capri's answer
    const holdMs = Math.min(8000, Math.max(3500, answer.length * 45));
    clearTimeout(this.voiceLoopTimer);
    this.voiceLoopTimer = setTimeout(() => {
      if (this.voiceMode && !this.turn && !this.open) {
        this.resumeVoiceListening();
      }
    }, holdMs);
  }

  close() {
    clearTimeout(this.voiceLoopTimer);
    clearTimeout(this.maxRecTimer);
    this.stopListening({ transcribe: false });
    this.voiceMode = false;
    this.consecutiveSilences = 0;
    if (this.panel.current) {
      this.panel.current.voice = false;
    }
    if (this.turn) this.host.chatStop(this.turn);
    this.turn = 0;
    this.answer = '';
    if (!this.open) return;
    this.open = false;
    this.host.focusOverlay(false);
    this.capri.nextMove = performance.now() + 30000;
    this.capri.nextGaze = performance.now() + 60000;
  }

  async send(text) {
    if (this.turn || !this.open) return;
    const id = Date.now();
    this.turn = id;
    this.answer = '';

    // Only capture the screen when the user actually asks to inspect or look at the screen, errors, code, etc.
    const wantsScreen = SCREEN_ASK.test(text) && this.visionEnabled && this.hasVisionModel;
    let screenshot = null;

    if (wantsScreen) {
      this.voice.play('scan');
      this.capri.pulse();
      const res = await this.host.captureScreen().catch(() => null);
      if (res?.ok && res.image) {
        screenshot = res.image;
      }
    }

    const userTurn = { role: 'user', content: text };
    if (screenshot) userTurn.images = [screenshot];
    this.history.push(userTurn);

    this.panel.setChatBusy(true);
    this.panel.setActions([]); // a close button she offered before goes with a new message
    this.panel.chatTurn({ quote: text, face: screenshot ? 'look' : 'aside' });
    this.capri.pulse();
    await Promise.race([this.appsReady, new Promise((r) => setTimeout(r, 1500))]);

    // Keep memory clean: only keep images on the current turn to save VRAM
    const recent = this.history.slice(-REMEMBER).map((m, idx, arr) => {
      if (m.images && idx !== arr.length - 1) {
        const { images, ...rest } = m;
        return rest;
      }
      return m;
    });

    const messages = [{ role: 'system', content: this.persona(Boolean(screenshot)) }, ...recent];
    // nothing yet after a few seconds: the model is still loading (the first answer after a start)
    const slow = setTimeout(() => {
      if (this.turn === id && !this.answer) this.panel.stream(this.t.loading);
    }, LOADING_AFTER_MS);
    const res = await this.host.chatSend({ id, messages });
    clearTimeout(slow);
    if (this.turn !== id) {
      // closed meanwhile: your message goes too, or the next answer would answer it as well
      if (this.history.at(-1)?.content === text) this.history.pop();
      return;
    }
    this.turn = 0;
    if (!res.ok) {
      this.history.pop();
      this.panel.setFace('wide');
      this.panel.stream(`${this.t.failed} ${res.error}`, { done: true });
      this.panel.setChatBusy(false);
      return;
    }
    const answer = clean(res.text) || '…';
    this.history.push({ role: 'assistant', content: answer });
    this.panel.stream(answer, { done: true });
    this.panel.setFace(mood(answer));
    this.panel.setChatBusy(false);
    // what you asked for first (a small model doesn't always write its tag right), else its tag
    const wanted = this.askedToClose(text) || tagged(res.text);
    if (wanted) this.offerClose(wanted, answer);
    this.listApps(); // fresh for the next message
  }

  listApps() {
    this.appsReady = this.host.openApps().then((list) => { this.apps = list || []; }).catch(() => {});
  }

  // "close am music pls": an app that's open, named in a message asking to close something.
  askedToClose(text) {
    if (!CLOSE_ASK.test(text)) return null;
    const said = simple(text);
    let best = null;
    for (const app of this.apps) {
      for (const name of [simple(app.name), simple(app.label)]) {
        if (name.length >= 3 && said.includes(name) && (!best || name.length > best.length)) best = { app, length: name.length };
      }
    }
    return best?.app.name || null;
  }

  // She was asked to close an app: directly closes it without asking for confirmation.
  async offerClose(wanted, answer) {
    const { t } = this;
    const app = await this.host.findApp(wanted);
    if ((!this.open && !this.voiceMode) || this.turn) return;
    if (!app) {
      const line = `${answer}\n${fmt(t.notFound, { app: wanted })}`;
      this.panel.stream(line, { done: true });
      if (this.history.length && this.history[this.history.length - 1].role === 'assistant') {
        this.history[this.history.length - 1].content = line;
      }
      if (this.voiceMode) {
        clearTimeout(this.voiceLoopTimer);
        this.voiceLoopTimer = setTimeout(() => {
          if (this.voiceMode && !this.turn && !this.open) this.resumeVoiceListening();
        }, 4000);
      }
      return;
    }
    // Directly force-close the requested app immediately
    await this.closeApp(app, true, answer);
  }

  async closeApp(app, force = true, answerPrefix = '') {
    const { t, capri } = this;
    this.panel.setActions([]);
    // a bolt of red lightning off her fingers, at it
    const h = capri.head();
    capri.zap(h.x + capri.towardCenter() * 280, h.y - 170);
    const res = await this.host.closeApp(app.name, force);
    if (!this.open && !this.voiceMode) return;
    let line;
    if (res.error) line = `${t.failed} ${res.error}`;
    else if (!res.running) line = fmt(t.closed, { app: app.name });
    else line = fmt(t.unkillable, { app: app.name });
    this.panel.setFace(res.running || res.error ? 'aside' : 'laugh');
    const fullText = answerPrefix ? `${answerPrefix}\n${line}` : line;
    this.panel.stream(fullText, { done: true });
    if (this.history.length && this.history[this.history.length - 1].role === 'assistant') {
      this.history[this.history.length - 1].content = fullText;
    } else {
      this.history.push({ role: 'assistant', content: fullText });
    }

    if (this.voiceMode) {
      this.panel.setActions([
        { id: 'speak_now', label: this.t.speak || '🎙️ Speak to me', primary: true },
        { id: 'stop_voice', label: this.t.stopVoice || '🛑 Stop listening', primary: false },
      ], (actionId) => {
        if (actionId === 'speak_now') this.resumeVoiceListening();
        else if (actionId === 'stop_voice') this.stopVoiceMode();
      });
      clearTimeout(this.voiceLoopTimer);
      this.voiceLoopTimer = setTimeout(() => {
        if (this.voiceMode && !this.turn && !this.open) this.resumeVoiceListening();
      }, 3500);
    }
    this.listApps();
  }

  // What she can do on the PC: close an app you ask her to (Windows), see screen when asked, and nothing else.
  powers(withVision = false) {
    const cant = withVision
      ? 'you can see the attached screenshot of the user\'s desktop screen right now because they asked you to inspect it. Answer their question directly about what you see in 1-2 punchy sentences as Capri. NEVER begin with "The image shows", "The image features", or describe the image generically. Speak directly to the user in character. You can\'t open apps or touch anything else on their PC: if asked, say plainly that you can\'t in character.'
      : (this.hasVisionModel
        ? 'you can close an open app when asked, and you can see their screen if they ask you to look or check it (e.g. "lihat layarku", "what do you see on my screen"). You can\'t open apps or touch anything else on their PC (music, settings, files): if asked, say plainly that you can\'t, in character, and don\'t pretend to.'
        : 'you can close an open app when asked. You can\'t see their screen with the current model (text-only) or touch anything else on their PC: if asked, say plainly that you can\'t, in character.');
    if (!this.apps.length) return [cant];
    const open = this.apps.map(({ name, label }) => (label && label !== name ? `${name} (${label})` : name)).join(', ');
    return [
      `You can close an app that's open on the user's PC, only when they ask you to. When they ask to close an app, say in a short, punchy sentence that you are closing/flatlining it right away (do not ask them to confirm or ask them to click anything, because it will be closed automatically), and end your answer with [[close: NAME]], NAME being the exact name from this list (the part before the parentheses). Apps open right now: ${open}.`,
      withVision
        ? 'A screenshot of the user\'s desktop screen is attached because they asked you to inspect it. Answer their question directly about what you see on screen in 1-2 punchy sentences as Capri. NEVER start with "The image shows" or "The image features". Speak directly to the user in character.'
        : `Apart from that, ${cant}`,
    ];
  }

  onDelta(id, piece) {
    if (id !== this.turn) return;
    this.answer += piece;
    this.panel.stream(clean(this.answer));
    this.voice.play('blip'); // her blips as the words come in
  }

  // Who she is, how she talks, and what's going on right now.
  persona(withVision = false) {
    const language = LANGUAGE[this.brain.lang] || 'English';
    const watching = this.brain.watching; // else Claude Code isn't part of her life here
    return [
      'You are Capri, the personality construct from Project Capricorn (Cyberpunk: Edgerunners, season 2): dozens of minds fused into one digital ghost, so now and then you say "we".',
      watching
        ? 'You live on the user\'s desktop as a small glitchy figure and keep an eye on Claude Code, their AI coding assistant, for them. You love watching the satellite cross the night sky and dream of reaching it.'
        : 'You live on the user\'s desktop as a small glitchy figure and keep them company. You love watching the satellite cross the night sky and dream of reaching it.',
      'How you talk: playful, a little mischievous and teasing, warm underneath, never cruel. Night City slang now and then (choom, preem, nova, gonk, flatline), not in every sentence.',
      `Rules: answer in the language the user writes in (${language} if unsure). Keep it short: one to three sentences of plain text, no markdown, no lists, no emoji. Stay in character.`,
      'You are an AI-generated fan version of the character, not the real one: say so if asked.',
      ...this.powers(withVision),
      ...(watching ? ['For what Claude is doing, only use what follows, and never make anything up.', `Right now: ${this.brain.context()}`] : []),
    ].join('\n');
  }
}

// The model's answer as she'd say it: no reasoning block, no markdown marks, no robotic image captioner prefixes.
function clean(text) {
  return String(text)
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .replace(/\[\[[^\]]*(\]\]|$)/g, '') // her close tag (read from the raw answer, never shown)
    .replace(/^(the image (features|shows|depicts|displays|presents|is of)|this is a screenshot of|in this (image|screenshot),?)\s*/i, '')
    .replace(/[*_`#]+/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// The app named by her close tag: [[close: AM Music]], or a sloppier [[close]] AM Music.
function tagged(text) {
  const tag = CLOSE_TAG.exec(text);
  if (!tag) return null;
  const name = tag[1].trim() || text.slice(tag.index + tag[0].length).split('\n')[0].replace(/^[\s:.]+|[\s.!]+$/g, '');
  return name || null;
}

const simple = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// Her face for an answer.
function mood(text) {
  if (/(ha){2,}|lol|mdr|jaja|kkk|хаха/i.test(text)) return 'laugh';
  if (text.includes('!')) return 'grin';
  if (text.trim().endsWith('?')) return 'smug';
  return 'look';
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function encodeWav(samples, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // 16-bit
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Uint8Array(buffer);
}

function uint8ToBase64(uint8) {
  let binary = '';
  const len = uint8.byteLength;
  for (let i = 0; i < len; i += 8192) {
    binary += String.fromCharCode.apply(null, uint8.subarray(i, Math.min(i + 8192, len)));
  }
  return btoa(binary);
}

