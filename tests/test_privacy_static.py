import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PYTHON = (ROOT / "streamlit_app.py").read_text(encoding="utf-8")
JS = (ROOT / "component.js").read_text(encoding="utf-8")


class PrivacyBoundaryTests(unittest.TestCase):
    def test_no_streamlit_movie_uploader(self):
        self.assertNotIn("file_uploader", PYTHON)
        self.assertNotIn("st.file_uploader", PYTHON)

    def test_movie_is_local_object_url(self):
        self.assertIn("URL.createObjectURL(file)", JS)
        self.assertIn('type="file"', JS)

    def test_movie_not_sent_in_realtime_messages(self):
        # Realtime messages are JSON metadata/control/signaling. No File/Blob is passed to send().
        self.assertNotIn("send(\"movie-bytes\"", JS)
        self.assertNotIn("FormData", JS)

    def test_webrtc_uses_camera_and_microphone(self):
        self.assertIn("navigator.mediaDevices.getUserMedia", JS)
        self.assertIn("RTCPeerConnection", JS)


if __name__ == "__main__":
    unittest.main()
