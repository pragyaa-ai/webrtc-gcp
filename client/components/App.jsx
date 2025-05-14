import { useEffect, useRef, useState } from "react";
import logo from "/assets/openai-logomark.svg";
import EventLog from "./EventLog";
import SessionControls from "./SessionControls";
import ToolPanel from "./ToolPanel";

export default function App() {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [events, setEvents] = useState([]);
  const [dataChannel, setDataChannel] = useState(null);
  const peerConnection = useRef(null);
  const audioElement = useRef(null);

  // Azure OpenAI configuration
  const WEBRTC_URL = process.env.WEBRTC_URL;
  const SESSIONS_URL = process.env.SESSIONS_URL;
  const API_KEY = process.env.AZURE_OPENAI_API_KEY;
  const DEPLOYMENT = "process.env.DEPLOYMENT";
  const VOICE = "verse";

  async function startSession() {
    try {
      // First get the ephemeral key from the sessions API
      const sessionResponse = await fetch(SESSIONS_URL, {
        method: "POST",
        headers: {
          "api-key": API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: DEPLOYMENT,
          voice: VOICE
        })
      });

      if (!sessionResponse.ok) {
        throw new Error('Failed to create session');
      }

      const sessionData = await sessionResponse.json();
      const EPHEMERAL_KEY = sessionData.client_secret?.value;

      // Create a peer connection
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      // Set up to play remote audio from the model
      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = true;
      document.body.appendChild(audioElement.current);

      pc.ontrack = (e) => {
        if (e.streams && e.streams[0]) {
          audioElement.current.srcObject = e.streams[0];
        }
      };

      // Add local audio track for microphone input
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        pc.addTrack(mediaStream.getAudioTracks()[0]);
      } catch (err) {
        console.error("Error accessing microphone:", err);
        // Continue without microphone if user denied permission
      }

      // Set up data channel for sending and receiving events
      const dc = pc.createDataChannel("azure-oai-events");
      setDataChannel(dc);

      // Start the session using SDP
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch(
        `${WEBRTC_URL}?model=${DEPLOYMENT}`,
        {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${EPHEMERAL_KEY}`,
            "Content-Type": "application/sdp",
          },
        });

      if (!sdpResponse.ok) {
        throw new Error('Failed to establish WebRTC connection');
      }

      const answer = {
        type: "answer",
        sdp: await sdpResponse.text(),
      };
      await pc.setRemoteDescription(answer);

      // Send initial session configuration
      if (dc.readyState === "open") {
        const initEvent = {
          type: "session.update",
          session: {
            instructions: "You are a helpful AI assistant responding in natural, engaging language."
          }
        };
        dc.send(JSON.stringify(initEvent));
      }

    } catch (error) {
      console.error("Session error:", error);
      stopSession();
    }
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }

    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      peerConnection.current.close();
      peerConnection.current = null;
    }

    if (audioElement.current) {
      audioElement.current.srcObject = null;
      document.body.removeChild(audioElement.current);
      audioElement.current = null;
    }

    setIsSessionActive(false);
  }

  function sendClientEvent(message) {
    if (dataChannel && dataChannel.readyState === "open") {
      const timestamp = new Date().toLocaleTimeString();
      message.event_id = message.event_id || crypto.randomUUID();
      message.timestamp = message.timestamp || timestamp;

      dataChannel.send(JSON.stringify(message));
      setEvents((prev) => [message, ...prev]);
    } else {
      console.error("Failed to send message - data channel not ready");
    }
  }

  function sendTextMessage(message) {
    const event = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: message,
          },
        ],
      },
    };
    sendClientEvent(event);
    sendClientEvent({ type: "response.create" });
  }

  useEffect(() => {
    if (dataChannel) {
      const handleMessage = (e) => {
        const event = JSON.parse(e.data);
        event.timestamp = event.timestamp || new Date().toLocaleTimeString();
        setEvents((prev) => [event, ...prev]);
      };

      const handleOpen = () => {
        setIsSessionActive(true);
        setEvents([]);
      };

      const handleClose = () => {
        setIsSessionActive(false);
      };

      dataChannel.addEventListener("message", handleMessage);
      dataChannel.addEventListener("open", handleOpen);
      dataChannel.addEventListener("close", handleClose);

      return () => {
        dataChannel.removeEventListener("message", handleMessage);
        dataChannel.removeEventListener("open", handleOpen);
        dataChannel.removeEventListener("close", handleClose);
      };
    }
  }, [dataChannel]);

  return (
    <>
      <nav className="absolute top-0 left-0 right-0 h-16 flex items-center">
        <div className="flex items-center gap-4 w-full m-4 pb-2 border-0 border-b border-solid border-gray-200">
          <img style={{ width: "24px" }} src={logo} />
          <h1>Azure OpenAI Realtime Console</h1>
        </div>
      </nav>
      <main className="absolute top-16 left-0 right-0 bottom-0">
        <section className="absolute top-0 left-0 right-[380px] bottom-0 flex">
          <section className="absolute top-0 left-0 right-0 bottom-32 px-4 overflow-y-auto">
            <EventLog events={events} />
          </section>
          <section className="absolute h-32 left-0 right-0 bottom-0 p-4">
            <SessionControls
              startSession={startSession}
              stopSession={stopSession}
              sendClientEvent={sendClientEvent}
              sendTextMessage={sendTextMessage}
              events={events}
              isSessionActive={isSessionActive}
            />
          </section>
        </section>
        <section className="absolute top-0 w-[380px] right-0 bottom-0 p-4 pt-0 overflow-y-auto">
          <ToolPanel
            sendClientEvent={sendClientEvent}
            sendTextMessage={sendTextMessage}
            events={events}
            isSessionActive={isSessionActive}
          />
        </section>
      </main>
    </>
  );
}