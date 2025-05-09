"use client";

import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";
import BottomToolbar from "./components/BottomToolbar";

// Types
import { AgentConfig, SessionStatus } from "@/app/types";

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";
import { useFunctionCalling } from "@/app/contexts/FunctionCallingContext";

// Utilities
import { createRealtimeConnection } from "./lib/realtimeConnection";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";

import useAudioDownload from "./hooks/useAudioDownload";

function CocaApp() {
  const searchParams = useSearchParams();
  // Use urlCodec directly from URL search params (default: "opus")
  const urlCodec = searchParams.get("codec") || "opus";
  const isDebugMode = searchParams.get("debug") === "true";
  const pushToTalk = searchParams.get("pushToTalk") === "true";
  const isTranscriptAllowed = searchParams.get("transcriptAllowed") !== "true";
  const { transcriptItems, addTranscriptMessage, addTranscriptBreadcrumb } =
    useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    AgentConfig[] | null
  >(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] =
    useState<boolean>(true);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);

  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] =
    useState<boolean>(false);

  const [lastAssistantMessage, setLastAssistantMessage] = useState<string>("");
  const [lastUserMessage, setLastUserMessage] = useState<string>("");
  const [isChallengeStarted, setIsChallengeStarted] = useState<boolean>(false);
  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();
  const [isTheUserWon, setIsTheUserWon] = useState<boolean>(false);
  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dcRef.current && dcRef.current.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dcRef.current.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });
  const { addFunction, functions } = useFunctionCalling();

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      const url = new URL(window.location.toString());
      url.searchParams.set("agentConfig", finalAgentConfig);
      window.location.replace(url.toString());
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      connectToRealtime();

      // Example: Adding a function to the context when connecting to realtime
      addFunction("exampleFunction", { param1: "value1", param2: "value2" });
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent);
      updateSession(true);
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      console.log(
        `updatingSession, isPTTACtive=${isPTTActive} sessionStatus=${sessionStatus}`
      );
      updateSession();
    }
  }, [isPTTActive]);

  useEffect(() => {
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");

    if (mostRecentAssistantMessage) {
      setLastAssistantMessage(mostRecentAssistantMessage.title || "");
    }
    const mostRecentUserMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "user");
    if (mostRecentUserMessage) {
      setLastUserMessage(mostRecentUserMessage.title || "");
    }
  }, [transcriptItems]);

  // console.table({
  //   lastAssistantMessage,
  //   lastUserMessage,
  //   isPTTUserSpeaking,
  //   isPTTActive,
  //   isOutputAudioBufferActive,
  //   sessionStatus,
  //   audioElementRef: audioElementRef.current,
  // });
  const fetchEphemeralKey = async (): Promise<string | null> => {
    logClientEvent({ url: "/session" }, "fetch_session_token_request");
    const tokenResponse = await fetch("/api/session");
    const data = await tokenResponse.json();
    logServerEvent(data, "fetch_session_token_response");

    if (!data.client_secret?.value) {
      logClientEvent(data, "error.no_ephemeral_key");
      console.error("No ephemeral key provided by the server");
      setSessionStatus("DISCONNECTED");
      return null;
    }

    return data.client_secret.value;
  };

  const connectToRealtime = async () => {
    if (sessionStatus !== "DISCONNECTED") return;
    setSessionStatus("CONNECTING");

    try {
      const EPHEMERAL_KEY = await fetchEphemeralKey();
      if (!EPHEMERAL_KEY) {
        return;
      }

      if (!audioElementRef.current) {
        audioElementRef.current = document.createElement("audio");
      }
      audioElementRef.current.autoplay = isAudioPlaybackEnabled;

      const { pc, dc } = await createRealtimeConnection(
        EPHEMERAL_KEY,
        audioElementRef,
        urlCodec
      );
      pcRef.current = pc;
      dcRef.current = dc;

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
      });
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
      });
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });
      dc.addEventListener("message", (e: MessageEvent) => {
        handleServerEventRef.current(JSON.parse(e.data));
      });

      setDataChannel(dc);
    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  };

  const disconnectFromRealtime = () => {
    if (pcRef.current) {
      pcRef.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });

      pcRef.current.close();
      pcRef.current = null;
    }
    setDataChannel(null);
    setSessionStatus("DISCONNECTED");
    setIsPTTUserSpeaking(false);

    logClientEvent({}, "disconnected");
  };

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
      "(simulated user text message)"
    );
    setLastUserMessage(text);

    sendClientEvent(
      { type: "response.create" },
      "(trigger response after simulated user text message)"
    );
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear audio buffer on session update"
    );

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 200,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "verse",
        input_audio_transcription: {
          model: "gpt-4o-transcribe",
          language: "en",
          prompt:
            "You will receive a voice message as answer of question in a challenge game. the audio will be always in english language. you should transcribe the audio to text and send it back to the server.",
        },
        turn_detection: turnDetection,
        tools,
      },
    };

    sendClientEvent(sessionUpdateEvent);

    if (shouldTriggerResponse) {
      sendSimulatedUserMessage("let's Play!");
    }
  };

  const cancelAssistantSpeech = async () => {
    // Send a response.cancel if the most recent assistant conversation item is IN_PROGRESS. This implicitly does a item.truncate as well
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");

    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent(
        { type: "response.cancel" },
        "(cancel due to user interruption)"
      );
    }

    // Send an output_audio_buffer.cancel if the isOutputAudioBufferActive is True
    if (isOutputAudioBufferActive) {
      sendClientEvent(
        { type: "output_audio_buffer.clear" },
        "(cancel due to user interruption)"
      );
    }
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setLastUserMessage(userText.trim());
    setUserText("");

    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open")
      return;
    cancelAssistantSpeech();

    setIsPTTUserSpeaking(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (
      sessionStatus !== "CONNECTED" ||
      dataChannel?.readyState !== "open" ||
      !isPTTUserSpeaking
    )
      return;

    setIsPTTUserSpeaking(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const onToggleConnection = () => {
    if (sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING") {
      disconnectFromRealtime();
      setSessionStatus("DISCONNECTED");
    } else {
      connectToRealtime();
    }
  };

  const handleAgentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newAgentConfig = e.target.value;
    const url = new URL(window.location.toString());
    url.searchParams.set("agentConfig", newAgentConfig);
    window.location.replace(url.toString());
  };

  const handleSelectedAgentChange = (
    e: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const newAgentName = e.target.value;
    setSelectedAgentName(newAgentName);
  };

  // Instead of using setCodec, we update the URL and refresh the page when codec changes
  const handleCodecChange = (newCodec: string) => {
    const url = new URL(window.location.toString());
    url.searchParams.set("codec", newCodec);
    window.location.replace(url.toString());
  };

  useEffect(() => {
    const storedPushToTalkUI = localStorage.getItem("pushToTalkUI");
    if (storedPushToTalkUI) {
      setIsPTTActive(storedPushToTalkUI === "true");
    }
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("pushToTalkUI", isPTTActive.toString());
  }, [isPTTActive]);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElementRef.current) {
      if (isAudioPlaybackEnabled) {
        audioElementRef.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElementRef.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElementRef.current?.srcObject) {
      // The remote audio stream from the audio element.
      const remoteStream = audioElementRef.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    // Clean up on unmount or when sessionStatus is updated.
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  const agentSetKey = searchParams.get("agentConfig") || "default";

  const challengeStarted =
    functions.find((func) => func.name === "track_challenge_started")?.arguments
      ?.isChallengeStarted || false;
  const languageSelected =
    functions.find((func) => func.name === "track_selected_language")?.arguments
      ?.language || "en";
  const track_participate_score =
    functions.find((func) => func.name === "track_participate_score")?.arguments
      ?.score || 0;
  const challenge_result_score =
    functions.find((func) => func.name === "challenge_result")?.arguments
      ?.score || 0;
  const challenge_result_status = functions.find(
    (func) => func.name === "challenge_result"
  )?.arguments?.status;

  useEffect(() => {
    if (challengeStarted) {
      setIsChallengeStarted(true);
    } else {
      setIsChallengeStarted(false);
    }
  }, [challengeStarted]);

  useEffect(() => {
    if (track_participate_score === 5) {
      setIsTheUserWon(false);
    }
  }, [track_participate_score]);

  console.log({ challenge_result_score, challenge_result_status });

  return (
    <div
      className={`text-base flex flex-col w-screen h-screen bg-no-repeat bg-cover bg-center ${
        isChallengeStarted ? "bg-[url(/animated-coca.gif)]" : "bg-white"
      } text-gray-800 relative`}
    >
      <div className="p-5 text-lg font-semibold flex justify-between items-start">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/coca-cola.png"
              alt="OpenAI Logo"
              width={50}
              height={50}
              className="mr-2"
            />
          </div>
          <div>
            Yes or No{" "}
            <span className="text-gray-200">
              Challenge {isTheUserWon && "winner winner"}
            </span>
          </div>
        </div>
        {isDebugMode && (
          <div className="flex items-center">
            <label className="flex items-center text-base gap-1 mr-2 font-medium">
              Scenario
            </label>
            <div className="relative inline-block">
              <select
                value={agentSetKey}
                onChange={handleAgentChange}
                className="appearance-none border border-gray-300 rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
              >
                {Object.keys(allAgentSets).map((agentKey) => (
                  <option key={agentKey} value={agentKey}>
                    {agentKey}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
            </div>

            {agentSetKey && (
              <div className="flex items-center ml-6">
                <label className="flex items-center text-base gap-1 mr-2 font-medium">
                  Agent
                </label>
                <div className="relative inline-block">
                  <select
                    value={selectedAgentName}
                    onChange={handleSelectedAgentChange}
                    className="appearance-none border border-gray-300 rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
                  >
                    {selectedAgentConfigSet?.map((agent) => (
                      <option key={agent.name} value={agent.name}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
                    <svg
                      className="h-4 w-4"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        {isChallengeStarted && (
          <div className="flex items-center gap-5 bg-black p-2 rounded-md text-white">
            <div className="text-sm text-white">
              Score : {track_participate_score}
            </div>
          </div>
        )}
        <div className="flex items-center gap-5 bg-black p-2 rounded-md text-white">
          <div className="text-sm text-white">{languageSelected}</div>
          <div
            className={`${
              sessionStatus === "CONNECTED" ? "bg-green-500" : "bg-red-500"
            } size-400 rounded-full w-3 h-3`}
          ></div>
        </div>
      </div>
      <div className="flex flex-col gap-2 px-2 w-full max-w-2xl mx-auto">
        <div className="p-4 rounded-md border border-gray-100  h-[200px] w-full text-center bg-white/30 backdrop-blur-none">
          {lastAssistantMessage}
        </div>
        <div className="p-4 rounded-md border h-[200px] text-center border-gray-100 bg-white/30 backdrop-blur-none">
          {lastUserMessage}
        </div>
      </div>

      {false && (
        <div className="flex flex-1 gap-2 px-2 overflow-hidden relative">
          <Transcript
            isTextAllowed={false}
            isTranscriptAllowed={false}
            userText={userText}
            setUserText={setUserText}
            onSendMessage={handleSendTextMessage}
            downloadRecording={downloadRecording}
            canSend={
              sessionStatus === "CONNECTED" &&
              dcRef.current?.readyState === "open"
            }
          />
          <Events isExpanded={isEventsPaneExpanded} />
        </div>
      )}
      <BottomToolbar
        pushToTalk={pushToTalk}
        isDebugMode={false}
        sessionStatus={sessionStatus}
        onToggleConnection={onToggleConnection}
        isPTTActive={isPTTActive}
        setIsPTTActive={setIsPTTActive}
        isPTTUserSpeaking={isPTTUserSpeaking}
        handleTalkButtonDown={handleTalkButtonDown}
        handleTalkButtonUp={handleTalkButtonUp}
        isEventsPaneExpanded={isEventsPaneExpanded}
        setIsEventsPaneExpanded={setIsEventsPaneExpanded}
        isAudioPlaybackEnabled={isAudioPlaybackEnabled}
        setIsAudioPlaybackEnabled={setIsAudioPlaybackEnabled}
        codec={urlCodec}
        onCodecChange={handleCodecChange}
      />
    </div>
  );
}

export default CocaApp;
