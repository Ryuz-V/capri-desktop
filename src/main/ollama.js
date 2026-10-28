'use strict';

// Talking to her: a local model through Ollama (https://ollama.com). Done from here, not from
// the overlay's page, which can't reach other local ports. Everything stays on this machine
// unless OLLAMA_HOST points somewhere else.

function base() {
  let host = process.env.OLLAMA_HOST || '127.0.0.1:11434';
  if (!/^https?:\/\//.test(host)) host = `http://${host}`;
  return host.replace('://0.0.0.0', '://127.0.0.1').replace(/\/+$/, '');
}

// Ollama's errors come as {"error": "..."}
async function failure(res) {
  const body = await res.text().catch(() => '');
  try {
    return new Error(JSON.parse(body).error);
  } catch {
    return new Error(body || `Ollama answered ${res.status}`);
  }
}

// The models installed, by name ("llama3.2:latest"...).
async function models() {
  const res = await fetch(`${base()}/api/tags`, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw await failure(res);
  const { models: list = [] } = await res.json();
  return list.map((m) => m.name);
}

// Loads the model into memory ahead of the first message (the first answer after a fresh start
// otherwise waits for it to load, which can take a while).
function warm(model) {
  if (!model) return;
  fetch(`${base()}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: '15m' }),
  }).catch(() => {});
}

// Native multimodal chat models that can natively understand images + conversation
const NATIVE_VISION_RE = /(llama3\.2-vision|minicpm-v|llava|qwen2-vl|bakllava|cogvlm)/i;
// Dedicated optical/VQA image scanners that extract visual descriptions (not conversational chatbots)
const SCANNER_VISION_RE = /(moondream)/i;

function isScannerModel(name) {
  return SCANNER_VISION_RE.test(String(name || ''));
}

function isNativeVisionModel(name) {
  return NATIVE_VISION_RE.test(String(name || ''));
}

function isVisionModel(name) {
  return isNativeVisionModel(name) || isScannerModel(name);
}

function hasVisionCapability(list = []) {
  return (list || []).some((m) => isVisionModel(m));
}

// Optical perception: uses an installed vision scanner (like moondream) to inspect desktop screenshot
async function scanScreen(imageBase64, scannerModel = 'moondream', signal) {
  const res = await fetch(`${base()}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: scannerModel,
      prompt: 'Briefly identify what is visible on this computer screen: active apps, window titles, open code or files, terminal logs, and any error messages.',
      images: [imageBase64],
      stream: false,
      keep_alive: 0, // Immediately free VRAM so conversational model (Llama 3.2) has full GPU memory
      options: { temperature: 0.2 },
    }),
    signal,
  });
  if (!res.ok) throw await failure(res);
  const data = await res.json();
  return data.response?.trim() || '';
}

// Free model memory immediately from VRAM
async function unload(model) {
  if (!model) return;
  try {
    await fetch(`${base()}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
    });
  } catch (_) {}
}

// Her answer, streamed: onDelta(piece) as it comes, resolves with all of it.
async function chat({ model, messages }, onDelta, signal, isRetry = false) {
  let outboundModel = model;
  let outboundMessages = messages;

  const imageTurn = messages.find((m) => Array.isArray(m.images) && m.images.length > 0);

  // If screenshot is attached but conversational model is text-only (like llama3.2):
  if (imageTurn && !isNativeVisionModel(model)) {
    const list = await models().catch(() => []);
    const scanner = list.find((m) => isScannerModel(m)) || list.find((m) => isNativeVisionModel(m));
    if (scanner) {
      try {
        const observation = await scanScreen(imageTurn.images[0], scanner, signal);
        if (observation) {
          outboundMessages = messages.map((m) => {
            if (m === imageTurn) {
              const { images, ...rest } = m;
              return {
                ...rest,
                content: `${rest.content}\n\n[Capri's optic cyberware scan of user's desktop:\n${observation}]`,
              };
            }
            return m;
          });
        }
      } catch (err) {
        console.warn('[capri] optical scan error:', err.message);
      }
    }
    // Clean remaining images if model cannot accept multimodal data directly
    outboundMessages = outboundMessages.map((m) => {
      if (m.images) {
        const { images, ...rest } = m;
        return rest;
      }
      return m;
    });
  }

  const hasImages = outboundMessages.some((m) => Array.isArray(m.images) && m.images.length > 0);

  try {
    const res = await fetch(`${base()}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: outboundModel,
        messages: outboundMessages,
        stream: true,
        keep_alive: '15m', // she stays loaded while you chat
        options: {
          temperature: 0.7,
          top_p: 0.9,
          top_k: 40,
          repeat_penalty: 1.15,
          num_predict: hasImages ? 380 : 240,
        },
      }),
      signal,
    });
    if (!res.ok) throw await failure(res);
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.error) throw new Error(msg.error);
        const piece = msg.message?.content || ''; // a thinking model's reasoning comes apart, and is left out
        if (piece) {
          text += piece;
          onDelta(piece);
        }
        if (msg.done) return text;
      }
    }
    return text;
  } catch (err) {
    const isRepeatError = /repeat|runner|aborted/i.test(String(err.message || ''));
    if (!isRetry && isRepeatError) {
      console.warn('[capri:ollama] Runner error detected, resetting model and retrying...', err.message);
      await unload(outboundModel);
      return chat({ model, messages }, onDelta, signal, true);
    }
    throw err;
  }
}

module.exports = { models, warm, unload, chat, scanScreen, isVisionModel, isScannerModel, isNativeVisionModel, hasVisionCapability };

