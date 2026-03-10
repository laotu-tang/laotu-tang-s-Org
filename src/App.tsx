import { useState, useEffect, useRef } from "react";
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import { Phone, PhoneIncoming, PhoneOff, History, MessageSquare, Settings, CheckCircle, XCircle, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface Call {
  id: string;
  phone_number: string;
  start_time: string;
  end_time: string | null;
  summary: string | null;
  transcript: string | null;
  status: string;
}

declare global {
  interface Window {
    aistudio: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

export default function App() {
  const [calls, setCalls] = useState<Call[]>([]);
  const [activeCall, setActiveCall] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [activeTab, setActiveTab] = useState<"history" | "settings" | "simulator">("history");
  const [outboundNumber, setOutboundNumber] = useState("");
  const [isCalling, setIsCalling] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  
  // Production Readiness Settings
  const [aiProvider, setAiProvider] = useState<"gemini" | "deepseek">("gemini");
  const [apiProxy, setApiProxy] = useState("");
  const [systemInstruction, setSystemInstruction] = useState("You are a helpful AI phone assistant. Be concise, professional, and friendly. If you don't know something, ask for clarification.");
  const [usageStats, setUsageStats] = useState({ totalMinutes: 0, totalCalls: 0 });
  
  const serverWsRef = useRef<WebSocket | null>(null);
  const geminiSessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  useEffect(() => {
    fetchCalls();
    const interval = setInterval(fetchCalls, 5000);
    
    // Connect to our server's WebSocket
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/frontend`);
    serverWsRef.current = ws;

    ws.onopen = () => setStatus("Connected to Server");
    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      
      if (data.event === "call_started") {
        setActiveCall(data.callSid);
        setIsLive(true);
        startGeminiSession(data.callSid);
      } else if (data.event === "call_ended") {
        setIsLive(false);
        setActiveCall(null);
        if (geminiSessionRef.current) {
          const transcript = "Real call transcript...";
          summarizeCall(data.callSid, transcript);
        }
      } else if (data.event === "audio_in" && geminiSessionRef.current) {
        const session = await geminiSessionRef.current;
        session.sendRealtimeInput({
          media: { data: data.payload, mimeType: "audio/pcm;rate=16000" }
        });
      }
    };

    return () => {
      ws.close();
      clearInterval(interval);
      stopSimulator();
    };
  }, []);

  const fetchCalls = async () => {
    try {
      const res = await fetch("/api/calls");
      const data = await res.json();
      setCalls(data);
    } catch (err) {
      console.error("Failed to fetch calls", err);
    }
  };

  const summarizeCall = async (callSid: string, transcript: string) => {
    try {
      // In a real app, we'd use Gemini to summarize the actual transcript
      // For now, we'll send a placeholder summary
      await fetch(`/api/calls/${callSid}/summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: "The caller inquired about business hours and left a message for the manager.",
          transcript: transcript
        })
      });
      fetchCalls();
    } catch (err) {
      console.error("Failed to summarize", err);
    }
  };

  const startGeminiSession = async (callSid: string, isLocal: boolean = false) => {
    try {
      setStatus("Initializing AI...");
      const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY;
      
      // If using DeepSeek or Proxy, the logic would change here. 
      // For now, we keep Gemini as default but structure for expansion.
      const ai = new GoogleGenAI({ 
        apiKey,
        // In a real marketized app, you'd pass the proxy URL to the SDK if supported
      });
      
      const sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: `${systemInstruction}\n\n${isLocal ? "This is a SIMULATED test call using the user's local microphone." : `Current Call ID: ${callSid}`}`,
        },
        callbacks: {
          onopen: () => {
            setStatus("AI Ready & Listening");
            if (isLocal) setupLocalAudio();
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              if (isLocal) {
                playLocalAudio(base64Audio);
              } else if (serverWsRef.current) {
                serverWsRef.current.send(JSON.stringify({
                  event: "audio_out",
                  payload: base64Audio
                }));
              }
            }
          },
          onclose: () => {
            setStatus("AI Session Closed");
            if (isLocal) stopSimulator();
          },
          onerror: (err) => {
            console.error("Gemini Error:", err);
            setStatus("AI Error");
          }
        }
      });

      geminiSessionRef.current = sessionPromise;
    } catch (err) {
      console.error("Failed to start Gemini session", err);
      setStatus("AI Failed to Start");
    }
  };

  // Simulator Audio Logic
  const setupLocalAudio = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      }
      const source = audioContextRef.current.createMediaStreamSource(stream);
      const processor = audioContextRef.current.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = async (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        // Convert Float32 to Int16
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
        }
        
        const session = await geminiSessionRef.current;
        if (session) {
          const base64 = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
          session.sendRealtimeInput({
            media: { data: base64, mimeType: "audio/pcm;rate=16000" }
          });
        }
      };

      source.connect(processor);
      processor.connect(audioContextRef.current.destination);
    } catch (err) {
      console.error("Mic access denied", err);
      setStatus("Mic Error");
    }
  };

  const playLocalAudio = (base64: string) => {
    if (!audioContextRef.current) return;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const pcmData = new Int16Array(bytes.buffer);
    const floatData = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) floatData[i] = pcmData[i] / 0x7FFF;

    const buffer = audioContextRef.current.createBuffer(1, floatData.length, 16000);
    buffer.getChannelData(0).set(floatData);
    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContextRef.current.destination);
    source.start();
  };

  const startSimulator = async () => {
    // Check for API key if needed
    if (typeof window !== "undefined" && window.aistudio) {
      const hasKey = await window.aistudio.hasSelectedApiKey();
      if (!hasKey) {
        await window.aistudio.openSelectKey();
        // Proceed after key selection
      }
    }

    // Create AudioContext on user gesture
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: 16000 });
    } else if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }

    setIsSimulating(true);
    setIsLive(true);
    startGeminiSession("sim-call-" + Date.now(), true);
  };

  const stopSimulator = () => {
    setIsSimulating(false);
    setIsLive(false);
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    // Don't close AudioContext, just suspend or keep it for next time
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.suspend();
    }
    if (geminiSessionRef.current) {
      summarizeCall("sim-" + Date.now(), "Simulated test conversation...");
    }
    setStatus("Simulator Stopped");
  };

  const makeCall = async () => {
    if (!outboundNumber) return;
    setIsCalling(true);
    try {
      const res = await fetch("/api/calls/make", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: outboundNumber })
      });
      const data = await res.json();
      if (!data.success) alert(`Failed to call: ${data.error}`);
    } catch (err) {
      console.error("Call error", err);
    } finally {
      setIsCalling(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F5F5F0] text-[#1A1A1A] font-sans">
      {/* Header */}
      <header className="bg-white border-b border-black/5 px-8 py-6 flex justify-between items-center sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center text-white">
            <Phone size={24} />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">AI Phone Assistant</h1>
            <p className="text-xs text-black/40 uppercase tracking-widest font-medium">Smart Receptionist</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 px-4 py-2 bg-black/5 rounded-full">
            <div className={`w-2 h-2 rounded-full ${isLive ? 'bg-red-500 animate-pulse' : 'bg-emerald-500'}`} />
            <span className="text-sm font-medium">{status}</span>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Sidebar Navigation */}
        <div className="lg:col-span-3 flex flex-col gap-2">
          <button 
            onClick={() => setActiveTab("history")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === "history" ? 'bg-white shadow-sm font-medium' : 'hover:bg-black/5 text-black/60'}`}
          >
            <History size={20} />
            Call History
          </button>
          <button 
            onClick={() => setActiveTab("simulator")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === "simulator" ? 'bg-white shadow-sm font-medium' : 'hover:bg-black/5 text-black/60'}`}
          >
            <MessageSquare size={20} />
            Virtual Simulator
          </button>
          <button 
            onClick={() => setActiveTab("settings")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === "settings" ? 'bg-white shadow-sm font-medium' : 'hover:bg-black/5 text-black/60'}`}
          >
            <Settings size={20} />
            Configuration
          </button>
        </div>

        {/* Content Area */}
        <div className="lg:col-span-9">
          {activeTab === "history" ? (
            <div className="space-y-6">
              {/* Outbound Call Bar */}
              <div className="bg-white p-4 rounded-2xl shadow-sm border border-black/5 flex gap-3">
                <input 
                  type="text" 
                  placeholder="Enter phone number to call..." 
                  value={outboundNumber}
                  onChange={(e) => setOutboundNumber(e.target.value)}
                  className="flex-1 px-4 py-2 bg-black/5 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                />
                <button 
                  onClick={makeCall}
                  disabled={isCalling || isLive}
                  className="px-6 py-2 bg-emerald-500 text-white rounded-xl text-sm font-medium hover:bg-emerald-600 transition-all disabled:opacity-50 flex items-center gap-2"
                >
                  {isCalling ? <Loader2 size={16} className="animate-spin" /> : <Phone size={16} />}
                  Make Call
                </button>
              </div>

              {isLive && (
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-white p-6 rounded-3xl shadow-sm border border-emerald-100 flex items-center justify-between"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-emerald-100 rounded-2xl flex items-center justify-center text-emerald-600">
                      <PhoneIncoming className="animate-bounce" />
                    </div>
                    <div>
                      <h3 className="font-semibold">Active Call Ongoing</h3>
                      <p className="text-sm text-black/40">AI is currently handling the conversation...</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Loader2 className="animate-spin text-emerald-500" size={20} />
                    <span className="text-sm font-medium text-emerald-600">Live Transcription</span>
                  </div>
                </motion.div>
              )}

              <div className="bg-white rounded-3xl shadow-sm overflow-hidden border border-black/5">
                <div className="px-6 py-4 border-b border-black/5 bg-black/[0.02] flex justify-between items-center">
                  <h2 className="font-semibold">Recent Calls</h2>
                  <span className="text-xs font-medium text-black/40 uppercase tracking-wider">{calls.length} Total</span>
                </div>
                
                <div className="divide-y divide-black/5">
                  {calls.length === 0 ? (
                    <div className="p-12 text-center text-black/40">
                      <MessageSquare size={48} className="mx-auto mb-4 opacity-20" />
                      <p>No calls recorded yet.</p>
                    </div>
                  ) : (
                    calls.map((call) => (
                      <motion.div 
                        key={call.id}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="p-6 hover:bg-black/[0.01] transition-colors group"
                      >
                        <div className="flex justify-between items-start mb-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-black/5 rounded-xl flex items-center justify-center text-black/60">
                              <Phone size={18} />
                            </div>
                            <div>
                              <div className="font-medium">{call.phone_number}</div>
                              <div className="text-xs text-black/40">{new Date(call.start_time).toLocaleString()}</div>
                            </div>
                          </div>
                          <div className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${call.status === 'ongoing' ? 'bg-emerald-100 text-emerald-700' : 'bg-black/5 text-black/40'}`}>
                            {call.status}
                          </div>
                        </div>
                        
                        {call.summary && (
                          <div className="bg-[#F9F9F7] p-4 rounded-2xl border border-black/5">
                            <p className="text-sm leading-relaxed text-black/70 italic">
                              "{call.summary}"
                            </p>
                          </div>
                        )}
                      </motion.div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : activeTab === "simulator" ? (
            <div className="bg-white p-12 rounded-3xl shadow-sm border border-black/5 text-center space-y-8">
              <div className="max-w-md mx-auto">
                <div className={`w-24 h-24 mx-auto rounded-full flex items-center justify-center mb-6 transition-all ${isSimulating ? 'bg-red-100 text-red-600 animate-pulse' : 'bg-emerald-100 text-emerald-600'}`}>
                  {isSimulating ? <PhoneOff size={40} /> : <PhoneIncoming size={40} />}
                </div>
                <h2 className="text-2xl font-bold mb-2">
                  {isSimulating ? "Simulated Call in Progress" : "Virtual Call Simulator"}
                </h2>
                <p className="text-black/40 mb-8">
                  {isSimulating 
                    ? "The AI is listening to your microphone. Speak now to test the response." 
                    : "Test the AI's voice and logic using your computer's microphone and speakers without a phone line."}
                </p>
                
                <button 
                  onClick={isSimulating ? stopSimulator : startSimulator}
                  className={`w-full py-4 rounded-2xl font-bold text-lg transition-all flex items-center justify-center gap-3 ${isSimulating ? 'bg-red-500 text-white hover:bg-red-600' : 'bg-emerald-500 text-white hover:bg-emerald-600'}`}
                >
                  {isSimulating ? (
                    <>
                      <PhoneOff size={24} />
                      End Simulation
                    </>
                  ) : (
                    <>
                      <PhoneIncoming size={24} />
                      Start Simulated Call
                    </>
                  )}
                </button>
              </div>

              {isSimulating && (
                <div className="flex justify-center gap-1 h-8 items-end">
                  {[...Array(12)].map((_, i) => (
                    <motion.div
                      key={i}
                      animate={{ height: [8, Math.random() * 32 + 8, 8] }}
                      transition={{ repeat: Infinity, duration: 0.5, delay: i * 0.05 }}
                      className="w-1 bg-emerald-500 rounded-full"
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="bg-white p-8 rounded-3xl shadow-sm border border-black/5 space-y-8">
              <div className="flex justify-between items-start">
                <div>
                  <h2 className="text-xl font-semibold mb-2">System Configuration</h2>
                  <p className="text-sm text-black/40">Manage your AI engines and telephony providers.</p>
                </div>
                <div className="bg-emerald-50 px-4 py-2 rounded-xl border border-emerald-100">
                  <span className="text-xs font-bold text-emerald-700 uppercase">Personal Plan</span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* AI Engine Settings */}
                <div className="space-y-4">
                  <h3 className="text-sm font-bold uppercase tracking-widest text-black/30">AI Engine</h3>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-xs font-medium">System Instruction (AI Personality)</label>
                      <textarea 
                        value={systemInstruction}
                        onChange={(e) => setSystemInstruction(e.target.value)}
                        placeholder="e.g. You are a secretary for a law firm..."
                        className="w-full px-4 py-3 bg-black/5 border border-black/5 rounded-xl text-sm h-24 resize-none focus:ring-2 focus:ring-emerald-500/20 outline-none"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium">Provider</label>
                      <select 
                        value={aiProvider}
                        onChange={(e) => setAiProvider(e.target.value as any)}
                        className="w-full px-4 py-3 bg-black/5 border border-black/5 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500/20 outline-none"
                      >
                        <option value="gemini">Google Gemini 2.5 (Best for Voice)</option>
                        <option value="deepseek">DeepSeek V3 (Most Cost Effective)</option>
                      </select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium">API Proxy URL (Optional for China)</label>
                      <input 
                        type="text" 
                        placeholder="https://your-proxy.com/v1" 
                        value={apiProxy}
                        onChange={(e) => setApiProxy(e.target.value)}
                        className="w-full px-4 py-3 bg-black/5 border border-black/5 rounded-xl text-sm"
                      />
                      <p className="text-[10px] text-black/30 italic">Required if deploying on servers within mainland China.</p>
                    </div>
                  </div>
                </div>

                {/* Twilio Settings */}
                <div className="space-y-4">
                  <h3 className="text-sm font-bold uppercase tracking-widest text-black/30">Telephony (Twilio)</h3>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-xs font-medium">Account SID</label>
                      <input type="password" value="••••••••••••••••" disabled className="w-full px-4 py-3 bg-black/5 border border-black/5 rounded-xl text-sm opacity-60" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium">Twilio Phone Number</label>
                      <input type="text" placeholder="+1234567890" className="w-full px-4 py-3 bg-black/5 border border-black/5 rounded-xl text-sm" />
                    </div>
                  </div>
                </div>
              </div>

              {/* Cost & Usage */}
              <div className="bg-black/5 p-6 rounded-2xl grid grid-cols-3 gap-4">
                <div className="text-center">
                  <div className="text-2xl font-bold">{usageStats.totalCalls}</div>
                  <div className="text-[10px] uppercase text-black/40 font-bold">Total Calls</div>
                </div>
                <div className="text-center border-x border-black/10">
                  <div className="text-2xl font-bold">{usageStats.totalMinutes}m</div>
                  <div className="text-[10px] uppercase text-black/40 font-bold">Duration</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-emerald-600">~$0.00</div>
                  <div className="text-[10px] uppercase text-black/40 font-bold">Est. Cost</div>
                </div>
              </div>

              <div className="bg-emerald-50 p-6 rounded-2xl border border-emerald-100">
                <h3 className="text-emerald-800 font-semibold mb-2 flex items-center gap-2">
                  <CheckCircle size={18} />
                  Webhook Setup
                </h3>
                <p className="text-sm text-emerald-700/80 mb-4">
                  Copy this URL to your Twilio Phone Number's "A CALL COMES IN" webhook setting:
                </p>
                <code className="block w-full p-3 bg-white/50 rounded-lg text-xs font-mono break-all border border-emerald-200">
                  {window.location.origin}/api/voice
                </code>
              </div>

              <div className="pt-4 border-top border-black/5 flex justify-end">
                <button className="px-8 py-3 bg-black text-white rounded-xl font-medium hover:bg-black/80 transition-all">
                  Save Configuration
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
