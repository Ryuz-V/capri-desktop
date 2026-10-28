import sys
import json
import base64
import io
import speech_recognition as sr

def main():
    try:
        input_data = sys.stdin.read().strip()
        if not input_data:
            print(json.dumps({"ok": False, "error": "No input received"}))
            return

        req = json.loads(input_data)
        wav_b64 = req.get("wavBase64", "")
        lang = req.get("lang", "id-ID")

        if not wav_b64:
            print(json.dumps({"ok": False, "error": "No audio data"}))
            return

        audio_bytes = base64.b64decode(wav_b64)
        r = sr.Recognizer()

        with sr.AudioFile(io.BytesIO(audio_bytes)) as source:
            audio = r.record(source)

        langs_to_try = [lang]
        if lang != "id-ID":
            langs_to_try.append("id-ID")
        if lang != "en-US":
            langs_to_try.append("en-US")

        recognized_text = None
        last_error = None

        for l in langs_to_try:
            try:
                text = r.recognize_google(audio, language=l)
                if text and len(text.strip()) > 0:
                    recognized_text = text.strip()
                    break
            except sr.UnknownValueError:
                continue
            except Exception as e:
                last_error = str(e)
                try:
                    text = r.recognize_whisper(audio, model="tiny")
                    if text and len(text.strip()) > 0:
                        recognized_text = text.strip()
                        break
                except:
                    pass

        if recognized_text:
            print(json.dumps({"ok": True, "text": recognized_text}))
        else:
            msg = "Suara tidak terdeteksi atau kurang jelas"
            if last_error:
                msg += f" ({last_error})"
            print(json.dumps({"ok": False, "error": msg}))

    except Exception as err:
        print(json.dumps({"ok": False, "error": str(err)}))

if __name__ == "__main__":
    main()
