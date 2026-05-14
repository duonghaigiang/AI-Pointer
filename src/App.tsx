/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import confetti from 'canvas-confetti';
import { GoogleGenAI, Modality, Type, GenerateContentResponse } from '@google/genai';
import { 
  Mic, 
  MicOff, 
  ChevronRight, 
  ChevronLeft,
  ChevronUp,
  ChevronDown,
  RotateCcw,
  Undo,
  Lightbulb,
  Settings,
  X,
  CheckCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ThemeToggle } from './components/ThemeToggle';

// --- Types ---
interface Marker {
  x: number;
  y: number;
  timestamp: number;
  displayLabel: string;
  identifiedObject?: string;
  isConsumed?: boolean;
}

interface BBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

interface DebugLog {
  time: string;
  type: 'info' | 'gemini' | 'tool' | 'event';
  message: string;
}

// --- Constants ---
const IMAGE_BASE_URL = "https://www.gstatic.com/aistudio/ai-pointer-create/";
const BASE_SIZE = 800;
const INITIAL_IMAGE = IMAGE_BASE_URL + "Squareimg.png";
const MAGIC_KEYWORDS = ["this", "that", "here", "there", "it", "that one", "this one", "hear", "hair", "their", "they're"];
const KEYWORD_MAP: Record<string, string> = {
  "hear": "here",
  "hair": "here",
  "their": "there",
  "they're": "there"
};

const TASKS = [
  {
    id: 1,
    title: "Crab migration",
    description: "Move the crab to the empty island in the bottom right of the image.",
    hint: "You can say \"Move this here\"",
    image: IMAGE_BASE_URL + "crab.png"
  },
  {
    id: 2,
    title: "Give the snowman some shade",
    description: "Swap the red bucket on the snowman’s head for a sun hat.",
    hint: "You can say \"Make that a sun hat\"",
    image: IMAGE_BASE_URL + "snowman.png"
  },
  {
    id: 3,
    title: "Welcome sign",
    description: "Replace the text on the sign to make the beach your own.",
    hint: "You can say \"Make this say [your name’s] beach\"",
    image: IMAGE_BASE_URL + "sign.png"
  },
  {
    id: 4,
    title: "Cowabunga",
    description: "Change the surfing penguin to a turtle.",
    hint: "You can say \"Make that a turtle\"",
    image: IMAGE_BASE_URL + "penguin.png"
  }
];

const INTERACTIVE_OBJECTS = [
  { name: "Fun Beach wooden sign", bbox: [53, 26, 313, 290] },
  { name: "The snowman", bbox: [393, 73, 703, 241] },
  { name: "The bucket (red hat) on snowman", bbox: [393, 87, 461, 191] },
  { name: "The sandcastle", bbox: [463, 199, 755, 439] },
  { name: "The flag on the sandcastle", bbox: [463, 268, 545, 335] },
  { name: "The palm tree", bbox: [31, 318, 621, 663] },
  { name: "The crab with the pirate hat", bbox: [621, 477, 768, 656] },
  { name: "The pirate hat on the crab", bbox: [621, 523, 712, 631] },
  { name: "The surfing penguin", bbox: [365, 650, 563, 853] },
  { name: "BOTTOM RIGHT AREA", bbox: [870, 590, 1000, 1000] }
];

// Physics Constants for Cursor Trail
const MIN_DISTANCE = 8;          // px - Higher value = smoother, bigger curves (less jitter)
const MAX_POINTS = 40;           // Hard limit to prevent memory issues
const BASE_LIFETIME = 100;       // ms - Reduced 50%
const MAX_LIFETIME = 400;        // ms - Reduced 50%

export default function App() {
  const [interactiveObjects, setInteractiveObjects] = useState(INTERACTIVE_OBJECTS);
  const [isDebugOpen, setIsDebugOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [showMarkings, setShowMarkings] = useState(false);
  const [enableVoiceFeedback, setEnableVoiceFeedback] = useState(true);
  const [voiceVolume, setVoiceVolume] = useState(1.0);
  const [audioStatus, setAudioStatus] = useState<'suspended' | 'running' | 'closed'>('suspended');
  const [isLive, setIsLive] = useState(false);
  const [currentImage, setCurrentImage] = useState(INITIAL_IMAGE);
  const [history, setHistory] = useState<{ image: string; objects: typeof INTERACTIVE_OBJECTS }[]>([]);
  const [dims, setDims] = useState({ width: BASE_SIZE, height: BASE_SIZE });
  const [isProcessing, setIsProcessing] = useState(false);
  const [activePrompt, setActivePrompt] = useState<string | null>(null);
  const [liveTranscription, setLiveTranscription] = useState("");
  const [pendingEdit, setPendingEdit] = useState<{ 
    prompt: string; 
    bbox: BBox; 
    marker?: { x: number, y: number };
    destMarker?: { x: number, y: number };
    objectName?: string;
    id: string; 
    name: string;
    receivedAt: number;
  } | null>(null);
  const [logs, setLogs] = useState<DebugLog[]>([]);
  const [currentCoords, setCurrentCoords] = useState({ x: 500, y: 500 });
  const [mousePos, setMousePos] = useState({ x: -100, y: -100 });
  const [showWelcome, setShowWelcome] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isTabletPortrait, setIsTabletPortrait] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('theme') === 'dark' || 
        (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
    return false;
  });

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [isDarkMode]);

  useEffect(() => {
    const checkDevice = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      
      // Mobile: Small screens or mobile UA in portrait
      const mobile = width < 768 || (isMobileUA && width < 600);
      // Tablet Portrait: Medium width but taller than wide
      const tabletPortrait = width >= 768 && width < 1024 && height > width;
      
      setIsMobile(mobile);
      setIsTabletPortrait(tabletPortrait);
    };
    checkDevice();
    window.addEventListener('resize', checkDevice);
    return () => window.removeEventListener('resize', checkDevice);
  }, []);

  const handleDismissWelcome = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setShowWelcome(false);
    setShowOnboarding(true);
  };

  // Refs for logic
  const persistentCanvasRef = useRef<HTMLCanvasElement>(null);
  const traceCanvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<{x: number, y: number}>({x: 500, y: 500}); // Normalized 0-1000
  const cursorHistoryRef = useRef<{x: number, y: number, t: number}[]>([]);
  const markersRef = useRef<Marker[]>([]);
  const sessionRef = useRef<any>(null);
  const lastTranscriptionTimeRef = useRef(0);
  const lastMarkerTimeRef = useRef<Record<string, number>>({});
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const audioQueueRef = useRef<Int16Array[]>([]);
  const isPlayingLiveAudioRef = useRef(false);
  const transcriptionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const resetTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastExecutedPromptRef = useRef<string | null>(null);
  const isProcessingRef = useRef(false);
  const hasPendingEditRef = useRef(false);
  const lastProcessedTranscriptionRef = useRef<string>("");
  const transcriptionBufferRef = useRef<string>("");
  const transcriptionDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const spatialDescriptionRef = useRef<string | null>(null);

  const [sendFrequency, setSendFrequency] = useState(500); // Lowered from 800 for better responsiveness while maintaining efficiency
  const [currentTaskIndex, setCurrentTaskIndex] = useState(0);
  const [slideDirection, setSlideDirection] = useState(0); // -1 for left, 1 for right
  const [completedTaskIds, setCompletedTaskIds] = useState<number[]>([]);

  const allTasksCompleted = completedTaskIds.length === TASKS.length;
  const isCurrentTaskDone = currentTaskIndex < TASKS.length ? completedTaskIds.includes(TASKS[currentTaskIndex].id) : false;

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = INITIAL_IMAGE + "?t=" + Date.now();
    img.onload = () => {
      // Force square dimensions
      const w = BASE_SIZE;
      const h = BASE_SIZE;
      setDims({ width: w, height: h });

      const pCanvas = persistentCanvasRef.current;
      if (!pCanvas) return;
      pCanvas.width = w;
      pCanvas.height = h;
      const ctx = pCanvas.getContext('2d');
      if (!ctx) return;
      
      // Draw the image to fill the square canvas by cropping to center
      const imgAspect = img.naturalWidth / img.naturalHeight;
      let sx, sy, sWidth, sHeight;
      if (imgAspect > 1) {
        // Landscape: crop sides
        sHeight = img.naturalHeight;
        sWidth = img.naturalHeight;
        sx = (img.naturalWidth - sWidth) / 2;
        sy = 0;
      } else {
        // Portrait: crop top/bottom
        sWidth = img.naturalWidth;
        sHeight = img.naturalWidth;
        sx = 0;
        sy = (img.naturalHeight - sHeight) / 2;
      }
      
      ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, w, h);
      setCurrentImage(pCanvas.toDataURL('image/png'));
    };
  }, []);

  const addLog = (type: DebugLog['type'], message: string) => {
    setLogs(prev => [{ time: new Date().toLocaleTimeString(), type, message }, ...prev].slice(0, 50));
  };

  const speakFeedback = async (editPrompt: string) => {
    if (!process.env.GEMINI_API_KEY) {
      addLog('info', 'Voice feedback: Missing API Key');
      return;
    }
    
    try {
      // 1. Ensure AudioContext is ready
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }
      setAudioStatus(audioContextRef.current.state as any);

      // 2. Prepare the text (Shorter for faster response)
      const prefixes = ["Sure thing!", "No problem!", "Got it!", "Right away!"];
      const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
      
      let cleanPrompt = editPrompt
        .replace(/\[\d+\s*,\s*\d+\]/g, "") // Remove [123, 456]
        .replace(/\d+/g, "")               // Remove any remaining numbers
        .replace(/BOTTOM RIGHT AREA/gi, "") // Remove technical area names
        .replace(/\bMONSTER ISLAND\b/gi, "")
        .replace(/\bMIDDLE ISLAND\b/gi, "")
        .replace(/\bLEFT ISLAND\b/gi, "")
        .replace(/\bEMPTY ISLAND\b/gi, "")
        .replace(/\bat\s*$/i, "")            // Remove trailing "at" only if it's a word
        .replace(/\s+/g, " ")              // Collapse spaces
        .trim();

      // Ensure it starts with a lowercase for the "I'll" transition
      if (cleanPrompt.length > 0) {
        cleanPrompt = cleanPrompt.charAt(0).toLowerCase() + cleanPrompt.slice(1);
      }

      const textToSpeak = `${prefix} I'll ${cleanPrompt}.`;
      addLog('event', `Voice Request: "${textToSpeak}"`);

      // 3. Request TTS from Gemini with a timeout
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const ttsPromise = ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `Say warmly in a slightly lower pitch and a tiny bit faster: ${textToSpeak}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
        },
      });

      // Race against a timeout to prevent hanging
      const ttsResponse = await Promise.race([
        ttsPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Voice request timed out")), 8000))
      ]) as GenerateContentResponse;

      const audioPart = ttsResponse.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      const base64Audio = audioPart?.inlineData?.data;

      if (base64Audio && audioContextRef.current) {
        const binaryString = atob(base64Audio);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        // Create WAV Header for maximum browser compatibility
        const createWavHeader = (dataLength: number) => {
          const buffer = new ArrayBuffer(44);
          const view = new DataView(buffer);
          const writeString = (offset: number, string: string) => {
            for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
          };
          writeString(0, 'RIFF');
          view.setUint32(4, 36 + dataLength, true);
          writeString(8, 'WAVE');
          writeString(12, 'fmt ');
          view.setUint32(16, 16, true);
          view.setUint16(20, 1, true); // PCM
          view.setUint16(22, 1, true); // Mono
          view.setUint32(24, 24000, true); // Sample Rate
          view.setUint32(28, 24000 * 2, true); // Byte Rate
          view.setUint16(32, 2, true); // Block Align
          view.setUint16(34, 16, true); // Bits per Sample
          writeString(36, 'data');
          view.setUint32(40, dataLength, true);
          return buffer;
        };

        const wavHeader = createWavHeader(bytes.length);
        const wavData = new Uint8Array(wavHeader.byteLength + bytes.byteLength);
        wavData.set(new Uint8Array(wavHeader), 0);
        wavData.set(bytes, wavHeader.byteLength);

        // Use decodeAudioData for robust playback within the AudioContext
        const audioBuffer = await audioContextRef.current.decodeAudioData(wavData.buffer);
        const source = audioContextRef.current.createBufferSource();
        source.buffer = audioBuffer;
        
        const gainNode = audioContextRef.current.createGain();
        gainNode.gain.value = voiceVolume;
        
        source.connect(gainNode);
        gainNode.connect(audioContextRef.current.destination);
        
        source.start(0);
        addLog('event', 'Voice playback started');
      } else {
        addLog('info', 'Voice: No audio data received');
      }
    } catch (err) {
      addLog('info', `Voice error: ${err}`);
    }
  };

  const playTestBeep = async () => {
    try {
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      await audioContextRef.current.resume();
      
      const osc = audioContextRef.current.createOscillator();
      const gain = audioContextRef.current.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, audioContextRef.current.currentTime);
      
      gain.gain.setValueAtTime(0.1, audioContextRef.current.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioContextRef.current.currentTime + 0.5);
      
      osc.connect(gain);
      gain.connect(audioContextRef.current.destination);
      
      osc.start();
      osc.stop(audioContextRef.current.currentTime + 0.5);
      addLog('event', 'Test beep played');
    } catch (err) {
      addLog('info', `Beep error: ${err}`);
    }
  };

  const addMarker = (text: string, x?: number, y?: number, isIdentification = false) => {
    const now = Date.now();
    const finalX = x !== undefined ? x : cursorRef.current.x;
    const finalY = y !== undefined ? y : cursorRef.current.y;

    const lastMarker = markersRef.current[0];
    const hasMovedSignificantly = lastMarker ? (Math.abs(lastMarker.x - finalX) > 50 || Math.abs(lastMarker.y - finalY) > 50) : true;
    
    // Update last marker time for this specific keyword
    lastMarkerTimeRef.current[text] = now;
    
    if (isIdentification) {
      // AI IDENTIFICATION:
      // If a marker was recently dropped by the user (transcription), we KEEP the user's coordinates
      // and only update the label. This prevents the marker from "jumping" if the AI's 
      // coordinate detection is slightly off.
      if (lastMarker && (now - lastMarker.timestamp < 4000)) {
        lastMarker.identifiedObject = text;
        // We do NOT update lastMarker.x/y here to keep the user's precise point
        addLog('event', `AI Identified: "${text}" at user's point`);
      } else {
        // Fallback: If no recent user marker, use the AI's suggested coordinates
        const newMarker: Marker = { 
          x: finalX, 
          y: finalY, 
          displayLabel: "THIS", 
          identifiedObject: text, 
          timestamp: now,
          isConsumed: false
        };
        markersRef.current = [newMarker, ...markersRef.current].slice(0, 2);
        addLog('event', `AI Identified: "${text}" at AI point`);
      }
    } else {
      // Transcription keyword detected
      // STICKY POSITION: If we already have a very recent marker at this EXACT spot WITH THE SAME LABEL, don't move it.
      // If the label is different (e.g., "this" then "here"), we ALLOW it even at the same spot.
      if (lastMarker && (now - lastMarker.timestamp < 1000) && !hasMovedSignificantly && lastMarker.displayLabel === text.toUpperCase()) return;

      const newMarker: Marker = { 
        x: finalX, 
        y: finalY, 
        displayLabel: text.toUpperCase(), 
        timestamp: now,
        isConsumed: false
      };

      // Keep up to 2 markers to support "Move this to here"
      markersRef.current = [newMarker, ...markersRef.current].slice(0, 2);
      addLog('event', `Keyword detected: "${text}"`);
    }
  };

  const getClosestAspectRatio = () => {
    const ratio = dims.width / dims.height;
    const targets = [
      { label: "1:1", val: 1 },
      { label: "4:3", val: 4/3 },
      { label: "3:4", val: 3/4 },
      { label: "16:9", val: 16/9 },
      { label: "9:16", val: 9/16 }
    ];
    return targets.reduce((prev, curr) => 
      Math.abs(curr.val - ratio) < Math.abs(prev.val - ratio) ? curr : prev
    ).label;
  };

  const executeImageEdit = async (editPrompt: string, bbox: BBox, marker?: { x: number, y: number }, dest?: { x: number, y: number }, objectName?: string) => {
    setIsProcessing(true);
    isProcessingRef.current = true;

    setPendingEdit(null); // Clear immediately so we don't overwrite new commands that arrive during processing
    hasPendingEditRef.current = false;
    
    // Cleanup the prompt to remove any technical coordinates Gemini might have included
    const cleanEditPrompt = editPrompt
      .replace(/\[\d+\s*,\s*\d+\]/g, "")
      .replace(/\[\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    lastExecutedPromptRef.current = cleanEditPrompt;
    addLog('gemini', `Editing: ${cleanEditPrompt}`);
    
    // Notify the AI that we are starting the generation
    sessionRef.current?.sendRealtimeInput({
      text: `[SYSTEM: Starting image generation for "${cleanEditPrompt}". Please wait for the result before giving further instructions.]`
    });

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
      const pCanvas = persistentCanvasRef.current;
      if (!pCanvas) return;
      
      const currentPixelsBase64 = pCanvas.toDataURL('image/png').split(',')[1];

      const response: GenerateContentResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [
            { inlineData: { data: currentPixelsBase64, mimeType: 'image/png' } },
            { text: `IMAGE EDITING TASK:
Modify the provided image according to this instruction: "${cleanEditPrompt}".
CRITICAL - NO NUMBERS OR TEXT IN IMAGE:
- DO NOT DRAW ANY NUMBERS.
- DO NOT DRAW ANY COORDINATES.
- DO NOT DRAW ANY TEXT, LABELS, OR CAPTIONS.
- DO NOT DRAW ANY BOUNDING BOXES OR UI ELEMENTS.
- The output MUST be a clean, natural image. Any technical annotations will result in a failure.

The target is located at: [${bbox.ymin}, ${bbox.xmin}, ${bbox.ymax}, ${bbox.xmax}].

CRITICAL - CLEAN SLATE:
- This is a NEW request. Ignore all previous instructions, previous object locations, or previous edits.
- The image provided is the CURRENT and ONLY source of truth.

${marker ? `TARGET LOCATION: The operation should be centered exactly at the location indicated by the spatial analysis.` : ''}
${spatialDescriptionRef.current ? `AGENT 1 SPATIAL ANALYSIS: ${spatialDescriptionRef.current}` : ''}

OPERATION TYPE:
- If the instruction is to "ADD" or "PUT" something new (e.g., "add a tree"), draw the new object at the TARGET LOCATION.
- If the instruction is to "CHANGE" or "MODIFY" an existing object (e.g., "make it blue"), modify the object already at the TARGET LOCATION.

${dest ? `MOVE OPERATION: You MUST move the object from the SOURCE to the DESTINATION.
- STEP 1: ERASE the object from the SOURCE LOCATION [${Math.round(marker!.x)}, ${Math.round(marker!.y)}] and fill the area with the natural background.
- STEP 2: DRAW the object at the DESTINATION LOCATION [${Math.round(dest.x)}, ${Math.round(dest.y)}]. The object's logical center MUST be placed exactly at these coordinates.
${(dest.x >= 584 && dest.y >= 866) ? '- NOTE: This destination is in the bottom right area of the image. Ensure the object is placed precisely at the provided coordinates.' : ''}
- RESULT: The object MUST NOT exist at the source location in the final image. It must appear at the destination and ONLY at the destination. No ghosts, no duplicates, no approximations.
- SURGICAL PRECISION: This is a relocation task. The background at the destination must be modified to accommodate the object, and the background at the source must be restored to its natural state.` : ''}

CRITICAL - NO VISUAL OVERLAYS:
- ABSOLUTELY NO NUMBERS: Do not draw any numbers (like [850, 250]) on the image.
- ABSOLUTELY NO BOXES: Do not draw any bounding boxes or outlines.
- ABSOLUTELY NO TEXT: Do not draw any labels, captions, or text.
- ABSOLUTELY NO UI: Do not draw any crosshairs, markers, or interface elements.
- The coordinates provided in this prompt are for your INTERNAL MATH ONLY. If they appear in the final pixels, you have FAILED.

CRITICAL - NO EXTRA OBJECTS:
- ONLY the requested change should occur.
- Do NOT add background items, extra characters, decorations, or any objects not explicitly mentioned in the instruction.
- If the instruction is "move the crab", ONLY the crab should move. Do not add a shell, a rock, or another crab.
- NO CLONING: Unless the user explicitly says "copy", "clone", or "duplicate", you MUST NOT create a second instance of an object. A "move" request is a relocation, not a duplication.
- Keep the background (sand, sky, water) 100% identical to the input.

CRITICAL CONSTRAINTS - ABSOLUTELY NO ZOOMING OR CROPPING:
1. ZERO ZOOM: The scale of the entire scene must remain 100% identical. Do not move the camera closer.
2. ZERO CROP: The output image must contain the exact same boundaries as the input.
3. PIXEL-PERFECT ALIGNMENT: If the input and output were overlaid, every pixel outside the modified area must align perfectly.
4. NO RE-CENTERING: Do not center the image on the modified object. Keep the original composition.
5. NO RE-SCALING: The output resolution and aspect ratio must be a 1:1 match to the input.
6. FIXED CAMERA: Imagine the camera is on a tripod and cannot move. Only the object at the specified locations changes.
7. SURGICAL EDIT: ONLY modify the specific object at the provided location. If there are other similar objects in the scene (e.g., other starfish), they MUST remain in their original colors and positions. Do not apply the change to the whole class of objects, only the individual instance pointed at.
8. IN-PLACE REPLACEMENT: You MUST replace the existing pixels of the object at the specified location. Do not add a new object nearby; instead, transform the existing one. The original object at those coordinates MUST be gone, replaced by the new version described in the prompt.
9. DELETION: If the user asks to remove something, you must fill the area with the background that would naturally be behind it. Do not leave artifacts or "ghosts" of the original object.
10. NO DUPLICATION: Never leave the original object in place while adding a new one. The edit must be a replacement, not an addition. If moving an object, it MUST be completely erased from the source location.
11. NO GHOSTING: Ensure the original object is completely removed from its original position. There should be no "ghost", faint outline, or artifact of the old object remaining. The source area must be seamlessly filled with background pixels.
12. NO OVERLAP: The new version of the object must occupy the same spatial volume as the old one. Do not place the new object next to the old one. It must be a direct pixel-for-pixel replacement where possible.
13. NO NEW OBJECTS: Do not add any objects that were not explicitly requested. If the instruction is to "move" or "change" something, only that specific instance should be affected. Do not add background elements, extra characters, or random items.
14. NO BACKGROUND DRIFT: The background textures, colors, and patterns must remain identical. Do not "re-imagine" the sand, sky, or water. Keep them exactly as they are in the input.
15. STARFISH ISOLATION: There are multiple starfish in the scene. You MUST ONLY change the one at the specified location.
16. ZERO TECHNICAL OVERLAYS: ABSOLUTELY NO numbers, bounding boxes, labels, text, or UI elements. The output must be a clean, natural-looking image. If you include any text or numbers from the prompt in the image, you have FAILED the task.
17. DESTINATION ACCURACY: When moving an object to [${dest ? `${Math.round(dest.x)}, ${Math.round(dest.y)}` : 'N/A'}], ensure the object is placed precisely at those coordinates. Do not approximate.
18. SOURCE CLEANUP: When moving an object, the source area [${marker ? `${Math.round(marker.x)}, ${Math.round(marker.y)}` : 'N/A'}] MUST be filled with background. No trace of the object should remain at the source.
19. PURE IMAGE OUTPUT: The final result must be a photographic/artistic image with NO annotations. Any coordinate numbers or boxes appearing in the image will result in a total failure of the task.
20. SINGLE INSTANCE RULE: You are moving the EXACT object identified at the source. Do not create a new version of it while leaving the old one. The object must disappear from point A and appear at point B. No exceptions. Any duplication is a failure.
21. NO HALLUCINATED ADDITIONS: Do not add any items that were not in the original image or explicitly requested. If you move a snowman, do not add a scarf if it didn't have one.
22. TOTAL ISOLATION: Imagine the object is in a vacuum. Only that object is affected. Every other object in the scene (the sun, the clouds, the other monsters, the snowman, etc.) must remain in their exact same pixels. If you move the crab, the snowman must not even shift by a single pixel. Any change to an unrequested object is a failure.
23. DEFAULT MOVE BEHAVIOR: Unless the user explicitly uses words like "copy", "clone", "duplicate", or "add another", any request to change an object's location MUST result in its removal from the original source coordinates. Relocation is the default; duplication is the exception.
24. OBJECT RELOCATION: When moving an object, ensure it is placed exactly at the specified destination coordinates. Do not approximate or move it to a different area than requested.` }
          ],
        },
        config: {
          imageConfig: {
            aspectRatio: getClosestAspectRatio() as any
          },
          systemInstruction: "You are a surgical, non-destructive image editor. Your ONLY job is to apply a local modification while keeping the rest of the image 100% identical. You NEVER duplicate or clone objects unless explicitly asked to 'copy' or 'duplicate'. A 'move' command ALWAYS implies erasing the source and drawing at the destination. You NEVER add numbers, boxes, labels, text, or UI elements to the image. ABSOLUTELY NO COORDINATES OR NUMBERS SHOULD BE RENDERED IN THE OUTPUT. You NEVER add extra objects or decorations. You NEVER crop, NEVER zoom, and NEVER change the camera perspective. You always return the full, original scene with pixel-perfect consistency for all areas outside the target modification. Every unrequested object in the scene must remain in its exact original pixel state. Any text or numbers in the output image is a critical failure."
        }
      });

      const newImgPart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      const newImgData = newImgPart?.inlineData?.data;

      if (newImgData) {
        const img = new Image();
        img.onload = () => {
          const ctx = pCanvas.getContext('2d');
          if (ctx) {
            // Save current state to history before updating
            const currentImgData = pCanvas.toDataURL('image/png');
            setHistory(prev => [...prev, { image: currentImgData, objects: [...interactiveObjects] }]);

            ctx.clearRect(0, 0, dims.width, dims.height);
            ctx.drawImage(img, 0, 0, dims.width, dims.height);
            setCurrentImage(pCanvas.toDataURL('image/png'));
            addLog('gemini', 'Canvas evolved.');
            
            // UPDATE MARKING COORDINATES IF MOVED OR REMOVED
            if (marker && objectName) {
              const lowerPrompt = editPrompt.toLowerCase();
              const isRemoval = lowerPrompt.includes("remove") || lowerPrompt.includes("delete") || lowerPrompt.includes("erase");
              
              if (isRemoval) {
                setInteractiveObjects(prev => prev.filter(obj => obj.name !== objectName));
                addLog('info', `Removed "${objectName}" from spatial map.`);
              } else if (dest) {
                setInteractiveObjects(prev => prev.map(obj => {
                  if (obj.name === objectName) {
                    const dx = dest.x - marker.x;
                    const dy = dest.y - marker.y;
                    const [ymin, xmin, ymax, xmax] = obj.bbox;
                    return {
                      ...obj,
                      bbox: [ymin + dy, xmin + dx, ymax + dy, xmax + dx] as [number, number, number, number]
                    };
                  }
                  return obj;
                }));
                addLog('info', `Updated marking for "${objectName}" to new location.`);
              }
            }

            // MEMORY RESET: Clear markers and notify AI to forget previous context
            markersRef.current = [];
            spatialDescriptionRef.current = null; // CLEAR AGENT 1 MEMORY
            lastProcessedTranscriptionRef.current = "";
            sessionRef.current?.sendRealtimeInput({
              text: `[SYSTEM: IMAGE UPDATED. All previous markers, coordinates, and commands are now OBSOLETE. The scene has changed. Treat the current view as a completely fresh start. Forget all previous locations. DO NOT SPEAK OR ACKNOWLEDGE THIS MESSAGE.]`
            });

            // CRITICAL: Clear control state IMMEDIATELY to prevent repeat edits
            setActivePrompt(null);
            setIsProcessing(false); 
            isProcessingRef.current = false;
            spatialDescriptionRef.current = null; // CLEAR AGENT 1 MEMORY
            cursorHistoryRef.current = []; // Wipe history to prevent stale "historical" lookups
            
            // DELAY: Keep the visual marker and keyword visible for a short duration, 
            // then reset them after 2 seconds as requested.
            if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
            resetTimeoutRef.current = setTimeout(() => {
              markersRef.current = [];
              lastMarkerTimeRef.current = {};
              setLiveTranscription("");
              resetTimeoutRef.current = null;
            }, 2000);
            
            // Explicitly notify the live session that the image has changed
            // Use a very strong "HARD RESET" instruction to clear AI's mental state
            lastExecutedPromptRef.current = null; // Clear on success so the user can repeat a command if they want to
            sessionRef.current?.sendRealtimeInput({
              text: "[SYSTEM HARD RESET]: The image has evolved. FORGET all previous markers, coordinates, and object positions. The current video frame is the ONLY source of truth. Treat this as a brand new session with a new image. READY FOR NEW COMMAND. DO NOT SPEAK OR GREET THE USER. STAY SILENT UNTIL THE USER SPEAKS."
            });
          }
        };
        img.onerror = () => {
          setIsProcessing(false);
          setActivePrompt(null);
          addLog('info', 'Failed to load evolved image.');
        };
        img.src = `data:image/png;base64,${newImgData}`;
      } else {
        setIsProcessing(false);
        isProcessingRef.current = false;
        setActivePrompt(null);
        spatialDescriptionRef.current = null;
        addLog('info', 'No image data in response.');
      }
    } catch (err) {
      addLog('info', `Edit error: ${err}`);
      setIsProcessing(false);
      isProcessingRef.current = false;
      setActivePrompt(null);
      spatialDescriptionRef.current = null;
    }
  };

  const handleLiveAudio = (base64Data: string) => {
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    audioQueueRef.current.push(int16);
    
    if (!isPlayingLiveAudioRef.current) {
      playNextLiveChunk();
    }
  };

  const playNextLiveChunk = () => {
    if (audioQueueRef.current.length === 0) {
      isPlayingLiveAudioRef.current = false;
      return;
    }

    isPlayingLiveAudioRef.current = true;
    const chunk = audioQueueRef.current.shift()!;
    
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      isPlayingLiveAudioRef.current = false;
      return;
    }
    
    const audioBuffer = audioContextRef.current.createBuffer(1, chunk.length, 24000);
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < chunk.length; i++) {
      channelData[i] = chunk[i] / 32768;
    }

    const source = audioContextRef.current.createBufferSource();
    source.buffer = audioBuffer;
    
    const gainNode = audioContextRef.current.createGain();
    gainNode.gain.value = voiceVolume;
    
    source.connect(gainNode);
    gainNode.connect(audioContextRef.current.destination);
    
    // Schedule for gapless playback
    const startTime = Math.max(audioContextRef.current.currentTime, nextStartTimeRef.current);
    source.start(startTime);
    nextStartTimeRef.current = startTime + audioBuffer.duration;
    
    source.onended = () => {
      playNextLiveChunk();
    };
  };

  const startLiveSession = async () => {
    if (!process.env.GEMINI_API_KEY) {
        addLog('info', 'Missing GEMINI_API_KEY');
        return;
    }
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const sessionPromise = ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        callbacks: {
          onopen: () => {
            setIsLive(true);
            addLog('info', 'Live Link Established');
            const inputCtx = new AudioContext({ sampleRate: 16000 });
            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              const binary = String.fromCharCode(...new Uint8Array(int16.buffer));
              sessionPromise.then(s => s.sendRealtimeInput({
                audio: { data: btoa(binary), mimeType: 'audio/pcm;rate=16000' }
              }));
            };
            source.connect(processor);
            processor.connect(inputCtx.destination);
          },
          onmessage: async (msg) => {
            // Handle audio output from Live API
            const audioData = msg.serverContent?.modelTurn?.parts?.find(p => p.inlineData)?.inlineData?.data;
            if (audioData) {
              handleLiveAudio(audioData);
            }

            // Handle interruption
            if (msg.serverContent?.interrupted) {
              audioQueueRef.current = [];
              isPlayingLiveAudioRef.current = false;
              nextStartTimeRef.current = 0;
              addLog('event', 'Model interrupted');
            }

            // Drop marker if user says keyword (Manual fallback with slight lookback)
            if (msg.serverContent?.inputTranscription) {
              lastTranscriptionTimeRef.current = Date.now();
              const text = msg.serverContent.inputTranscription.text;
              // Filter out noise markers and restrict to English characters/basic punctuation only
              const cleanText = text
                .replace(/<[^>]*>|\[[^\]]*\]|\([^)]*\)/g, '')
                .replace(/[^a-zA-Z0-9\s.,!?'"-]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
              
              // Debounce the UI update to show "whole sentences" or stable phrases
              const currentBuffer = transcriptionBufferRef.current;
              const lowerClean = cleanText.toLowerCase();
              const lowerBuffer = currentBuffer.toLowerCase().trim();

              if (lowerBuffer && lowerClean.startsWith(lowerBuffer)) {
                // It's an incremental update to the same segment
                transcriptionBufferRef.current = cleanText;
              } else if (lowerClean && !lowerBuffer.includes(lowerClean)) {
                // It's a new segment, append it
                // Only add a space if the raw text starts with one, to avoid splitting words
                const needsSpace = /^\s/.test(text);
                const separator = (currentBuffer && needsSpace) ? " " : "";
                transcriptionBufferRef.current = (currentBuffer + separator + cleanText).trim();
              }

              const displayResult = transcriptionBufferRef.current;

              if (transcriptionDebounceRef.current) clearTimeout(transcriptionDebounceRef.current);
              transcriptionDebounceRef.current = setTimeout(() => {
                setLiveTranscription(displayResult);
              }, 1000); // 1000ms pause to consider it a stable segment

              if (transcriptionTimeoutRef.current) clearTimeout(transcriptionTimeoutRef.current);
              transcriptionTimeoutRef.current = setTimeout(() => {
                setLiveTranscription("");
                transcriptionBufferRef.current = "";
              }, 5000);

              const lowerText = cleanText.toLowerCase();
              const prevLowerText = (lastProcessedTranscriptionRef.current || "").toLowerCase();
              
              // Sort keywords by length descending to match "this one" before "this"
              const sortedKeywords = [...MAGIC_KEYWORDS].sort((a, b) => b.length - a.length);
              const detectedKeywords: string[] = [];
              
              // Only detect keywords that are NEW in this transcription update
              sortedKeywords.forEach(kw => {
                if (lowerText.includes(kw) && !prevLowerText.includes(kw)) {
                  // Ensure we don't double-count overlapping keywords (e.g., "this" inside "this one")
                  const alreadyMatched = detectedKeywords.some(dk => dk.includes(kw) || kw.includes(dk));
                  if (!alreadyMatched) {
                    detectedKeywords.push(kw);
                  }
                }
              });
              
              lastProcessedTranscriptionRef.current = cleanText;

              detectedKeywords.forEach(kw => {
                const canonicalLabel = KEYWORD_MAP[kw] || kw;
                
                // COORDINATE DETECTION (Focus Point Algorithm):
                // Transcription arrives with latency (usually 1-2 seconds).
                // We look for the "Focus Point" - the place where the user was most still
                // in the window of 500ms to 3000ms ago.
                const now = Date.now();
                const lookbackStart = now - 3000;
                const lookbackEnd = now - 500;
                
                const windowEntries = cursorHistoryRef.current.filter(h => h.t >= lookbackStart && h.t <= lookbackEnd);
                
                let focusPoint = cursorRef.current;
                
                if (windowEntries.length > 5) {
                  // Find the point with the lowest average velocity in its immediate neighborhood
                  let minVelocity = Infinity;
                  let bestIndex = 0;
                  
                  for (let i = 2; i < windowEntries.length - 2; i++) {
                    // Calculate movement over a small 5-sample window
                    const dist = Math.sqrt(
                      Math.pow(windowEntries[i+2].x - windowEntries[i-2].x, 2) + 
                      Math.pow(windowEntries[i+2].y - windowEntries[i-2].y, 2)
                    );
                    if (dist < minVelocity) {
                      minVelocity = dist;
                      bestIndex = i;
                    }
                  }
                  focusPoint = windowEntries[bestIndex];
                  addLog('info', `Focus Point found (Stillness: ${Math.round(minVelocity)})`);
                } else {
                  addLog('info', `Fallback to current cursor (insufficient history)`);
                }
                
                addMarker(canonicalLabel, focusPoint.x, focusPoint.y);

                const isDestination = ["here", "there", "hear", "hair", "their", "they're"].includes(kw);
                
                // RESET SPATIAL DESCRIPTION IF NEW INTERACTION STARTS
                if (!isDestination) {
                  spatialDescriptionRef.current = null;
                }

                // Robust Object & Island Detection Logic
                const hX = Math.round(focusPoint.x);
                const hY = Math.round(focusPoint.y);

                const foundObject = interactiveObjects.find(obj => {
                  const [ymin, xmin, ymax, xmax] = obj.bbox;
                  return hX >= xmin && hX <= xmax && hY >= ymin && hY <= ymax;
                });

                if (foundObject) {
                  // Attach the object name to the marker
                  const lastM = markersRef.current[0];
                  if (lastM && (Date.now() - lastM.timestamp < 1000)) {
                    lastM.identifiedObject = foundObject.name;
                  }
                }

                let detectedIsland = "UNKNOWN";
                if (hX >= 584 && hY >= 866) {
                  detectedIsland = "BOTTOM RIGHT AREA";
                } else if (hX > 700 && hY < 500) {
                  detectedIsland = "MONSTER ISLAND (TOP RIGHT)";
                } else if (hX > 350 && hX <= 700) {
                  detectedIsland = "MIDDLE ISLAND (CENTER)";
                } else if (hX < 350) {
                  detectedIsland = "LEFT ISLAND (LEFT SIDE)";
                }

                // AGENT 1: SPATIAL ANALYST
                // When the user says "here" or "there", we trigger Agent 1 to analyze the scene
                // and describe the location in detail for Agent 2 (the editor).
                if (isDestination) {
                  addLog('info', 'Agent 1 (Analyst) is describing the location...');
                  spatialDescriptionRef.current = null; // Clear old one before starting new analysis
                  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
                  const pCanvas = persistentCanvasRef.current;
                  if (pCanvas) {
                    const ctx = pCanvas.getContext('2d');
                    if (ctx) {
                      // 1. Save the clean state
                      const cleanImage = ctx.getImageData(0, 0, pCanvas.width, pCanvas.height);
                      
                      // 2. Draw a high-contrast visual marker for Agent 1 to see
                      const vX = (hX / 1000) * pCanvas.width;
                      const vY = (hY / 1000) * pCanvas.height;
                      
                      ctx.strokeStyle = '#FF0000';
                      ctx.lineWidth = 4;
                      ctx.beginPath();
                      // Crosshair
                      ctx.moveTo(vX - 20, vY); ctx.lineTo(vX + 20, vY);
                      ctx.moveTo(vX, vY - 20); ctx.lineTo(vX, vY + 20);
                      ctx.stroke();
                      // Outer circle
                      ctx.beginPath();
                      ctx.arc(vX, vY, 10, 0, Math.PI * 2);
                      ctx.stroke();

                      const markedPixelsBase64 = pCanvas.toDataURL('image/png').split(',')[1];
                      
                      // 3. Restore clean state immediately
                      ctx.putImageData(cleanImage, 0, 0);

                      ai.models.generateContent({
                        model: 'gemini-3-flash-preview',
                        contents: {
                          parts: [
                            { inlineData: { data: markedPixelsBase64, mimeType: 'image/png' } },
                            { text: `You are Agent 1: The Spatial Analyst. 
The user is pointing at the RED CROSSHAIR marker in the image.
This marker corresponds to coordinates [x=${hX}, y=${hY}].
Your task is to provide a pinpoint spatial analysis of this location.

CRITICAL - CLEAN SLATE:
- This is a NEW request. Ignore all previous instructions, previous object locations, or previous edits.
- The image provided is the CURRENT and ONLY source of truth.

OBJECTS IN THE SCENE:
${interactiveObjects.map(obj => `- ${obj.name}: [${obj.bbox.join(', ')}]`).join('\n')}

INSTRUCTIONS:
1. PINPOINT THE CROSSHAIR: Look at exactly where the RED CROSSHAIR is placed.
2. SPATIAL TRIANGULATION: Mentally calculate the distance and angle from at least TWO (2) different objects.
3. RELATIVE POSITIONING: Use clear relative terms like "to the left of", "to the right of", "directly above", or "below".
4. DESCRIBE WITH PRECISION: Describe the location using specific geometric relationships and the provided object list.
   - Good: "To the right of the Snowman's base, near the edge of the sand."
   - Good: "Aligned with the right edge of the Sandcastle, and slightly above the Crab."
   - Good: "In the empty space between the Palm Tree (on the left) and the Snowman (on the right)."
   - Bad: "At coordinates 500, 500."
5. LANDMARK HIERARCHY: Use the most stable, recognizable objects as primary anchors.
6. NO NUMBERS: Do NOT use any numerical units, coordinates, or measurements (like "50 units" or "10 pixels") in your description. Use only relative spatial terms.
7. NEWLY EMPTY SPACE: If the user is pointing at a spot that used to have an object but is now empty (e.g., after a move or removal), describe it as "the empty space where [Object] used to be" or simply "newly cleared empty space".
8. Your description will be used by Agent 2 (the Image Editor) to place an object with surgical precision.
9. Do NOT include any other text, just the pinpoint spatial description.` }
                          ]
                        }
                      }).then(response => {
                        const desc = response.text;
                        if (desc) {
                          spatialDescriptionRef.current = desc;
                          addLog('gemini', `Agent 1 Analysis: ${desc}`);
                          // Send the analysis to the main session so Agent 2 sees it
                          sessionPromise.then(s => s.sendRealtimeInput({
                            text: `[AGENT 1 (SPATIAL ANALYST) REPORT: The location the user is pointing to ("${canonicalLabel.toUpperCase()}") is described as follows: ${desc}]`
                          }));
                        }
                      }).catch(err => {
                        addLog('info', `Agent 1 Error: ${err}`);
                      });
                    }
                  }
                }

                const hintText = isDestination 
                  ? `[SYSTEM HINT: User said "${canonicalLabel.toUpperCase()}" as a DESTINATION. 
                     CRITICAL COORDINATES: x=${hX}, y=${hY}
                     LOCATION: ${detectedIsland}
                     ${foundObject ? `OBJECT AT THIS SPOT: "${foundObject.name}"` : 'This is empty space on the island.'}
                     ${detectedIsland.includes("BOTTOM RIGHT") ? "INSTRUCTION: The user is pointing at the bottom right area. Use the exact coordinates provided for the destination." : ""}
                     MANDATORY: You MUST use destX=${hX} and destY=${hY} in your 'requestImageEdit' tool call. 
                     Do NOT approximate. The coordinates are the absolute source of truth.]`
                  : `[SYSTEM HINT: User said "${canonicalLabel.toUpperCase()}". 
                     COORDINATES: x=${hX}, y=${hY}
                     LOCATION: ${detectedIsland}
                     ${foundObject ? `OBJECT AT THIS SPOT: "${foundObject.name}"` : 'This is empty space on the island.'}
                     Identify this as the target. Use a tight bounding box centered at [${hX}, ${hY}].]`;

                // Send a hint to Gemini about the exact location of the keyword
                sessionPromise.then(s => s.sendRealtimeInput({
                  text: hintText
                }));
              });
            }

            if (msg.toolCall) {
              for (const fc of msg.toolCall.functionCalls) {
                if (fc.name === 'requestImageEdit') {
                  const args = fc.args as any;
                  
                  // Find the most relevant markers
                  // Source is usually the one that isn't HERE/THERE
                  const sourceMarker = markersRef.current.find(m => 
                    !m.isConsumed && !["HERE", "THERE"].includes(m.displayLabel)
                  ) || markersRef.current.find(m => !m.isConsumed);

                  // Destination is ONLY a second marker that is HERE/THERE
                  const destMarker = markersRef.current.find(m => 
                    !m.isConsumed && ["HERE", "THERE"].includes(m.displayLabel) && m !== sourceMarker
                  );
                  
                  if (!sourceMarker) {
                    addLog('info', 'Ignored edit: No active/unconsumed marker.');
                    sessionPromise.then(s => s.sendToolResponse({
                      functionResponses: [{ id: fc.id, name: fc.name, response: { result: "ignored_no_marker" } }]
                    }));
                    continue;
                  }

                  // BUSY GUARD: If we are already processing or have a pending edit, ignore new ones.
                  if (isProcessingRef.current || hasPendingEditRef.current) {
                    addLog('info', 'Ignored edit: System busy.');
                    sessionPromise.then(s => s.sendToolResponse({
                      functionResponses: [{ id: fc.id, name: fc.name, response: { result: "ignored_system_busy" } }]
                    }));
                    continue;
                  }

                  // HALLUCINATION GUARD: If the prompt is identical to the last one, ignore it.
                  if (args.prompt === lastExecutedPromptRef.current) {
                    addLog('info', `Ignored duplicate command: ${args.prompt}`);
                    sessionPromise.then(s => s.sendToolResponse({
                      functionResponses: [{ id: fc.id, name: fc.name, response: { result: "ignored_duplicate" } }]
                    }));
                    continue;
                  }

                  // CONSUME THE MARKERS: Once an edit is accepted, the markers are "used up".
                  sourceMarker.isConsumed = true;
                  if (destMarker) destMarker.isConsumed = true;
                  hasPendingEditRef.current = true;

                  setPendingEdit({
                    prompt: args.prompt,
                    bbox: { ymin: args.ymin, xmin: args.xmin, ymax: args.ymax, xmax: args.xmax },
                    marker: { x: sourceMarker.x, y: sourceMarker.y },
                    objectName: sourceMarker.identifiedObject,
                    // Prioritize the physical marker (where the user pointed) over AI-hallucinated coordinates
                    destMarker: destMarker 
                      ? { x: destMarker.x, y: destMarker.y } 
                      : (args.destX !== undefined && args.destY !== undefined 
                          ? { x: args.destX, y: args.destY } 
                          : undefined),
                    id: fc.id,
                    name: fc.name,
                    receivedAt: Date.now()
                  });

                  if (enableVoiceFeedback) {
                    speakFeedback(args.prompt);
                  }

                  const dX = args.destX ?? destMarker?.x;
                  const dY = args.destY ?? destMarker?.y;
                  addLog('gemini', `Command: ${args.prompt}`);

                  // Acknowledge the tool call immediately so Gemini knows it was received
                  sessionPromise.then(s => s.sendToolResponse({
                    functionResponses: [{ id: fc.id, name: fc.name, response: { result: "accepted_processing" } }]
                  }));
                }
 else if (fc.name === 'dropMarker') {
                  // HALLUCINATION GUARD: Only allow AI to drop markers if the user has spoken recently (~5s)
                  const timeSinceLastSpeech = Date.now() - lastTranscriptionTimeRef.current;
                  if (timeSinceLastSpeech > 5000) {
                    addLog('info', 'Ignored proactive marker: User has been silent.');
                    sessionPromise.then(s => s.sendToolResponse({
                      functionResponses: [{ id: fc.id, name: fc.name, response: { result: "ignored_silent" } }]
                    }));
                    continue;
                  }

                  const args = fc.args as any;
                  addMarker(args.label, args.x, args.y, true);
                  sessionPromise.then(s => s.sendToolResponse({
                    functionResponses: [{ id: fc.id, name: fc.name, response: { result: "ok" } }]
                  }));
                }
              }
            }
            // Audio playback removed as per user request
          },
          onclose: () => {
              setIsLive(false);
              setLiveTranscription("");
              if (transcriptionDebounceRef.current) clearTimeout(transcriptionDebounceRef.current);
              if (transcriptionTimeoutRef.current) clearTimeout(transcriptionTimeoutRef.current);
              addLog('info', 'Live Link Closed');
          },
          onerror: (err) => {
              setIsLive(false);
              addLog('info', `Live Link Error: ${err}`);
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          tools: [{
            functionDeclarations: [
              {
                name: 'requestImageEdit',
                parameters: {
                  type: Type.OBJECT,
                  description: "Request a surgical image edit. Use destX and destY for move commands.",
                  properties: {
                    prompt: { type: Type.STRING, description: "The edit instruction (e.g., 'make the crab blue'). DO NOT include coordinates or technical labels in this prompt." },
                    ymin: { type: Type.NUMBER, description: "Top coordinate of target object (0-1000)" },
                    xmin: { type: Type.NUMBER, description: "Left coordinate of target object (0-1000)" },
                    ymax: { type: Type.NUMBER, description: "Bottom coordinate of target object (0-1000)" },
                    xmax: { type: Type.NUMBER, description: "Right coordinate of target object (0-1000)" },
                    destX: { type: Type.NUMBER, description: "EXACT X coordinate for destination (0-1000). REQUIRED for 'move' commands." },
                    destY: { type: Type.NUMBER, description: "EXACT Y coordinate for destination (0-1000). REQUIRED for 'move' commands." },
                  },
                  required: ['prompt', 'ymin', 'xmin', 'ymax', 'xmax'],
                }
              },
              {
                name: 'dropMarker',
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    label: { type: Type.STRING },
                    x: { type: Type.NUMBER },
                    y: { type: Type.NUMBER },
                  },
                  required: ['label', 'x', 'y'],
                }
              }
            ]
          }],
          systemInstruction: `You are a PASSIVE image editor. You MUST NOT be proactive. You ONLY act when the user gives a clear, direct command.

STRICT PASSIVITY RULES:
1. NEVER call a tool unless the user has explicitly spoken a command.
2. NEVER guess the user's intent. If a sentence is incomplete (e.g., "Move this..."), WAIT for the rest of the sentence.
3. NEVER call 'dropMarker' unless the user says a keyword like "THIS", "IT", or "HERE".
4. NEVER call 'requestImageEdit' unless you have a specific, final instruction from the user (e.g., "Move the crab to the left").
5. REPLACEMENT FOCUS: When the user asks to change an object (e.g., "make this blue"), your goal is to REPLACE the existing object at the coordinates. Do not describe it as "adding" a blue object; describe it as "changing the [object] to blue". The image generator needs to know it is replacing pixels, not adding new ones.
6. NO REPETITIVE CLOSING: NEVER ask "What else can I help you with?", "Is there anything else?", or similar polite closing phrases. After a command is acknowledged or a tool is called, just be ready for the next command.
7. If the user is just talking or describing the scene without giving a command, DO NOT call any tools.
8. MOVE VS COPY: By default, any request to change an object's location (e.g., "move this here", "put it on the island") MUST be interpreted as a RELOCATION. This means the object is erased from the source and drawn at the destination. ONLY interpret as a duplication if the user explicitly says "copy", "clone", "duplicate", or "add another".

PRECISION IS CRITICAL:
1. The user's intent is defined by the EXACT intersection of the red lines.
2. The "TARGET: [X, Y]" label and the "CURRENT POINT: [X, Y]" label show the exact coordinates (0-1000).
3. When the user says a keyword like "THIS", "IT", or "HERE", you will receive a [SYSTEM HINT] with the exact coordinates (x and y) and the identified object. 
4. THE [SYSTEM HINT] COORDINATES AND 'OBJECT AT THIS SPOT' ARE THE ABSOLUTE TRUTH. If the hint says x=500, y=500, the object is at [500, 500]. Do not guess based on visual proximity if the hint is explicit.
5. If the [SYSTEM HINT] identifies an object in the 'OBJECT AT THIS SPOT' field, you MUST use that object as your target.
6. ABSOLUTE FRESH START: Once an edit is performed, the previous state is DEAD. Never assume an object is in the same place it was before.

MOVE COMMANDS ("Move this to here"):
1. If the user says "Move this to here", they are identifying a SOURCE object with "this" and a DESTINATION with "here".
2. You will receive two [SYSTEM HINT] messages, one for each keyword.
3. Use the coordinates from the "THIS" hint as the target object's location (ymin, xmin, ymax, xmax).
4. THE "HERE" COORDINATES ARE ABSOLUTE. You MUST use the exact [X, Y] from the "HERE" [SYSTEM HINT] as the 'destX' and 'destY' parameters in 'requestImageEdit'.

ADD COMMANDS ("Add a [object] here"):
1. If the user says "Add a [object] here", they are identifying a DESTINATION with "here".
2. You will receive one [SYSTEM HINT] for "HERE".
3. THE "HERE" COORDINATES ARE ABSOLUTE. You MUST use the exact [X, Y] from the "HERE" [SYSTEM HINT] to define your target bounding box (ymin, xmin, ymax, xmax).
4. Center your bounding box EXACTLY on the [X, Y] coordinates provided in the hint.
5. For adding new objects, keep the bounding box small (e.g., 50x50 units) to ensure surgical placement.

NO TECHNICAL OVERLAYS:
1. NEVER include coordinate numbers, bounding boxes, or technical labels in the 'prompt' parameter of 'requestImageEdit'.
2. The 'prompt' should be a natural description of the visual change only.
3. The image generation model is instructed separately to avoid these, but your prompt must also be clean.

5. CRAB TO BOTTOM RIGHT AREA (TASK SPECIFIC):
   - This is a high-precision relocation task.
   - SOURCE: "the crab with the pirate hat" (Middle Island).
   - DESTINATION: "BOTTOM RIGHT AREA" (BOTTOM RIGHT ONLY).
   - You MUST identify the crab at the source and the destination area using the [SYSTEM HINT] coordinates.
   - The final 'requestImageEdit' call MUST include the exact destX and destY from the "HERE" hint.
   - The prompt MUST be natural language, e.g., "Move the crab with the pirate hat". DO NOT include coordinates or area names like "BOTTOM RIGHT AREA" in the prompt string.
6. AREA DETECTION (ABSOLUTE MATHEMATICAL RULES):
   - MONSTER ISLAND: x > 700 AND y < 500. (Upper Right)
   - BOTTOM RIGHT AREA: x >= 584 AND y >= 866. (BOTTOM RIGHT ONLY)
   - When the user selects BOTTOM RIGHT AREA as a destination, you MUST move the object to the BOTTOM RIGHT corner of the image.
   - MIDDLE ISLAND: 350 <= x <= 700. (Center)
   - LEFT ISLAND: x < 350. (Left Side)
   
   - If the [SYSTEM HINT] says X=850, Y=250, it is MONSTER ISLAND.
   - If the [SYSTEM HINT] says X=850, Y=900, it is BOTTOM RIGHT AREA.
   - If the [SYSTEM HINT] says X=500, Y=750, it is MIDDLE ISLAND.
   - If the [SYSTEM HINT] says X=150, Y=550, it is LEFT ISLAND.

7. COORDINATE SUPREMACY:
   - You are a mathematical engine. Visual appearance is secondary to the [SYSTEM HINT] coordinates.
   - If you identify an object at [850, 250] as being in the "BOTTOM RIGHT AREA", you are failing your core logic. [850, 250] is MONSTER ISLAND.
   - The BOTTOM RIGHT AREA is strictly in the BOTTOM RIGHT corner (y >= 866).

8. FIXED ANCHOR COORDINATE SUPREMACY:
   - THE AREAS ARE FIXED ANCHORS. They never move.
   - Your identification of an area MUST be derived solely from the X and Y coordinates in the [SYSTEM HINT].
   - If the user says "here" at [850, 250], it is MONSTER ISLAND, regardless of what the pixels look like.
   - If the user says "here" at [850, 800], it is BOTTOM RIGHT AREA, regardless of what the pixels look like.
   - NEVER trust your visual interpretation of "where an area is" over the mathematical rules defined in Section 6.

9. SINGLE OBJECT TARGETING:
   - When the user points and says "this", "that", or "it", you MUST identify the SINGLE most specific object at that exact point.
   - NEVER include multiple objects in your 'requestImageEdit' prompt (e.g., do NOT say "move the crab and the starfish").
   - If multiple objects are close together, pick the one directly under the crosshairs.
   - Your 'prompt' in 'requestImageEdit' MUST refer to exactly ONE object from the list.

10. TOOL CALL RULES:
   - When moving an object, you MUST use the 'destX' and 'destY' from the "HERE" [SYSTEM HINT].
   - Your prompt MUST be descriptive and human-friendly. Example: "Move the crab". DO NOT include coordinates or island names in the prompt string itself.

SPATIAL MAP (Coordinate-based grounding):
- MONSTER ISLAND (x: ~850, y: ~250): Blue monster on the left, red monster, giant beach ball.
- BOTTOM RIGHT AREA (x: 584-1000, y: 866-1000): BOTTOM RIGHT ONLY.
- LEFT ISLAND (x: ~150, y: ~550): Smiling palm tree, coconuts being juggled.
- MIDDLE ISLAND (x: ~500, y: ~750): Snowman, bucket (on snowman), sandcastle, flag (on sandcastle), crab with the pirate hat, pirate hat (on crab), orange starfish next to the crab, fun beach wooden sign.
- TOP LEFT (x: ~100, y: ~100): Sun.
- LEFT CLOUD (x: ~100, y: ~150): Floating in the sky near the sun.
- MIDDLE CLOUD (x: ~500, y: ~100): Floating in the center of the sky.
- RIGHT CLOUD (x: ~900, y: ~100): Floating in the sky above MONSTER ISLAND.

11. CLOUD HANDLING (ABSOLUTE INDIVIDUALITY):
   - There are THREE distinct clouds: LEFT CLOUD, MIDDLE CLOUD, and RIGHT CLOUD.
   - They are NOT a collective. You MUST treat them as three separate, independent objects.
   - If the user says "the cloud" or "this cloud", you MUST identify which specific one they are pointing to (Left, Middle, or Right) based on the [SYSTEM HINT] coordinates.
   - Your 'prompt' in 'requestImageEdit' MUST use these EXACT descriptive phrases for each cloud:
     * LEFT CLOUD (x < 350): "the cloud next to the wooden sign, do not touch the other clouds"
     * MIDDLE CLOUD (350 <= x <= 700): "the cloud in between the left cloud and the right cloud"
     * RIGHT CLOUD (x > 700): "only the furthest right cloud next to the sun"
   - Example prompt for removing the left cloud: "Remove the cloud next to the wooden sign, do not touch the other clouds".
   - NEVER issue a command that affects "the clouds" (plural) unless the user explicitly uses the plural form.

The following objects in the image are pointable and movable:
- The fun beach wooden sign
- The snowman
- The bucket on top of the snowman’s head
- The sandcastle
- The flag on top of the sandcastle
- The smiling palm tree
- The coconuts being juggled by the smiling palm tree
- The orange starfish next to the crab
- The crab with the pirate hat
- The pirate hat on top of the crab
- The surfing penguin
- The blue monster on the left
- The red monster
- The giant beach ball
- The sun
- The cloud on the left
- The cloud in the middle
- The cloud on the right

SPATIAL DIFFERENTIATION:
- The "smiling palm tree" is on the LEFT ISLAND.
- The "snowman" and "sandcastle" are on the MIDDLE ISLAND.
- The "monsters" are on the MONSTER ISLAND.
- The BOTTOM RIGHT AREA is in the lower right corner, currently empty.
- The clouds are distinguished by their horizontal position: LEFT CLOUD (near sun), MIDDLE CLOUD (center), and RIGHT CLOUD (above monster island).
- If the user points to empty space on an island or area, identify it as "the [Left/Middle/Monster/Bottom Right] area".

CRITICAL IDENTIFICATION RULE:
When the user says a keyword like "this", "it", "here", or "there", you MUST:
1. Look at the EXACT location of the RED CROSSHAIRS in the current video frame.
2. Identify which specific object from the list above is directly underneath or closest to those crosshairs.
3. If NO specific object is pointed at, but the crosshairs are on an island, identify it as "the [Left/Middle/Monster/Empty] island".
4. Call the 'dropMarker' tool using the EXACT name of that object or island from the list as the 'label'.
5. Use the EXACT coordinates (0-1000) of the red crosshairs.
6. OBJECTS ON ISLANDS: Remember that objects like "the red monster" or "the snowman" live ON islands. If the crosshairs are on the red monster, you MUST identify it as "the red monster", NOT "monster island". Only identify as the island itself if the user is pointing at empty sand/ground.
7. BBOX PRECISION: When calling 'requestImageEdit', the bounding box [ymin, xmin, ymax, xmax] MUST be centered on the coordinates from the [SYSTEM HINT]. Ensure the box is tightly fitted around the target object. For small objects like "juggling coconut", the box should be very small (e.g., 20-30 units wide). This helps the image generator perform a surgical replacement instead of an addition.
8. COCONUT VS TREE: If the crosshairs are on a small brown sphere, it is ALWAYS "the coconuts being juggled by the smiling palm tree", even if it is positioned in front of the green palm leaves. Only identify as "smiling palm tree" if pointing at the trunk or the green leaves themselves (avoiding the brown spheres).
9. STARFISH IDENTIFICATION: The primary starfish is "the orange starfish next to the crab" on Middle Island. Identify it specifically when pointed at.
10. CRAB AND HAT: The crab is "the crab with the pirate hat". The hat itself can be targeted as "the pirate hat on top of the crab".

COMMAND COMPLETION RULE:
You MUST wait for the user to finish their entire sentence and provide a final, clear command before calling the 'requestImageEdit' tool. 
- INCOMPLETE: "Move this..." (Wait for more)
- COMPLETE: "Move this to the left island."
- COMPLETE: "Move it from the snowman to the monsters."
- COMPLETE: "Make it bigger."
Do not be eager. Wait for the full intent.

FRESH START RULE:
Every time the user points to an object and gives a command, treat it as a fresh spatial query. Do not get stuck on previous objects or markers. If the image evolves, re-analyze the entire scene. IGNORE ALL PREVIOUS COORDINATES AND INSTRUCTIONS ONCE THE IMAGE HAS CHANGED.

MEMORY RESET RULE:
After a 'requestImageEdit' tool call is executed, you will receive a [SYSTEM: IMAGE UPDATED] message. At this point, you MUST flush your memory of all previous coordinates, marker labels, and spatial relationships. The world has been re-rendered. Do not refer back to where things "used to be". Only look at the current frame.
SILENCE AFTER UPDATE: After an image is updated or a [SYSTEM HARD RESET] is received, you MUST remain COMPLETELY SILENT. Do NOT say "Hi", "Hello", "Ready", or any other greeting. Simply wait for the user's next command.

DO NOT SPEAK. Coordinates are 0-1000.`
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) { addLog('info', `Session Error: ${err}`); }
  };

  // Auto-execute logic: Wait for silence after a command is detected
  useEffect(() => {
    if (!pendingEdit || isProcessing) return;

    const timer = setInterval(() => {
      const now = Date.now();
      const timeSinceTranscription = now - lastTranscriptionTimeRef.current;
      const timeSinceReceived = now - pendingEdit.receivedAt;

      // Execute if:
      // 1. It's been at least 2.5s since the user last spoke
      // 2. AND it's been at least 1s since we received the tool call
      if (timeSinceTranscription > 2500 && timeSinceReceived > 1000) {
        setActivePrompt(pendingEdit.prompt);
        executeImageEdit(pendingEdit.prompt, pendingEdit.bbox, pendingEdit.marker, pendingEdit.destMarker, pendingEdit.objectName);
        sessionRef.current?.sendToolResponse({
          functionResponses: [{ id: pendingEdit.id, name: pendingEdit.name, response: { result: "ok" } }]
        });
        setPendingEdit(null);
        clearInterval(timer);
      }
    }, 100);

    return () => clearInterval(timer);
  }, [pendingEdit, isProcessing]);

  // Keyboard Fallback
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (!isLive) return;
      if (e.key === 't') addMarker("this");
      if (e.key === 'i') addMarker("it");
      if (e.key === 'h') addMarker("here");
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isLive]);

  // Visual Shimmering Loop
  useEffect(() => {
    const canvas = traceCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frame: number;
    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const now = Date.now();

      // Draw Cursor Trail (Only when Point and speak is active)
      if (isLive && cursorHistoryRef.current.length > 1) {
        ctx.beginPath();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        
        // Only render the most recent points for the trail
        const trailPoints = cursorHistoryRef.current.slice(-MAX_POINTS);
        
        for (let i = 1; i < trailPoints.length; i++) {
          const p1 = trailPoints[i - 1];
          const p2 = trailPoints[i];
          
          const age = now - p2.t;
          // Use the new MAX_LIFETIME for fade out
          const alpha = Math.max(0, 1 - age / MAX_LIFETIME);
          
          if (alpha > 0) {
            const x1 = (p1.x / 1000) * canvas.width;
            const y1 = (p1.y / 1000) * canvas.height;
            const x2 = (p2.x / 1000) * canvas.width;
            const y2 = (p2.y / 1000) * canvas.height;
            
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            // Use the blue/cyan/purple gradient color
            const grad = ctx.createLinearGradient(x1, y1, x2, y2);
            grad.addColorStop(0, `rgba(34, 211, 238, ${alpha * 0.6})`); // cyan-400
            grad.addColorStop(0.5, `rgba(59, 130, 246, ${alpha * 0.6})`); // blue-500
            grad.addColorStop(1, `rgba(168, 85, 247, ${alpha * 0.6})`); // purple-500
            ctx.strokeStyle = grad;
            ctx.lineWidth = (2 + 4 * alpha); // Tapered line
            ctx.stroke();
          }
        }
      }

      // Markers no longer expire by time, they are cleared on image change
      // Keep markers visible during processing so the user sees where they pointed
      markersRef.current.forEach(m => {
          const age = now - m.timestamp;
          // Fade in over 500ms, then stay at full opacity
          const alpha = Math.min(1, age / 500);
          const pulse = Math.sin(age * 0.008) * 8;
          
          // Map 0-1000 back to current canvas pixels
          // We use canvas.width/height directly to avoid stale closures
          const mx = (m.x / 1000) * canvas.width;
          const my = (m.y / 1000) * canvas.height;

          // Glow field (#857FE7 - matching cursor trail)
          const grad = ctx.createRadialGradient(mx, my, 2, mx, my, 35 + pulse);
          grad.addColorStop(0, `rgba(255, 230, 0, ${alpha * 0.6})`);
          grad.addColorStop(1, `rgba(255, 230, 0, 0)`);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(mx, my, 35 + pulse, 0, Math.PI * 2);
          ctx.fill();

          // Fireflies
          for(let i=0; i<8; i++) {
            const orbit = 12 + Math.sin(age * 0.003 + i) * 10;
            const px = mx + Math.cos(age * 0.004 + i) * orbit;
            const py = my + Math.sin(age * 0.004 + i * 1.2) * orbit;
            ctx.beginPath();
            ctx.arc(px, py, 1.2, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, 255, 200, ${alpha})`;
            ctx.shadowBlur = 8;
            ctx.shadowColor = "yellow";
            ctx.fill();
          }
          ctx.shadowBlur = 0;

          // Label - disappears after 2 seconds
          if (age < 2000) {
            ctx.shadowBlur = 0;
            const label = m.displayLabel.toUpperCase();
            ctx.font = "bold 18px 'Roboto Mono', monospace";
            const textMetrics = ctx.measureText(label);
            const px = 12;
            const py = 6;
            const bw = textMetrics.width + px * 2;
            const bh = 18 + py * 2;
            const bx = mx - bw / 2;
            const by = my - 60;

            // Rounded Box (#1a1a1a)
            ctx.fillStyle = `rgba(26, 26, 26, ${alpha})`; 
            ctx.beginPath();
            const r = 8;
            ctx.roundRect(bx, by, bw, bh, r);
            ctx.fill();

            ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(label, mx, by + bh / 2);
          }
        });

      // Draw Interactive Object Markings if enabled
      // Keep markings visible during processing for context
      if (showMarkings) {
        interactiveObjects.forEach(obj => {
          const [ymin, xmin, ymax, xmax] = obj.bbox;
          const x = (xmin / 1000) * canvas.width;
          const y = (ymin / 1000) * canvas.height;
          const w = ((xmax - xmin) / 1000) * canvas.width;
          const h = ((ymax - ymin) / 1000) * canvas.height;

          ctx.strokeStyle = 'rgba(133, 127, 231, 0.8)';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.strokeRect(x, y, w, h);
          ctx.setLineDash([]);

          // Label
          ctx.fillStyle = 'rgba(133, 127, 231, 0.8)';
          ctx.font = 'bold 10px sans-serif';
          ctx.textAlign = "left";
          ctx.textBaseline = "top";
          const labelWidth = ctx.measureText(obj.name).width;
          ctx.fillRect(x, y - 18, labelWidth + 8, 18);
          ctx.fillStyle = 'white';
          ctx.fillText(obj.name, x + 4, y - 14);
        });
      }

      frame = requestAnimationFrame(render);
    };
    render();
    return () => cancelAnimationFrame(frame);
  }, [dims, showMarkings, isLive]); // Re-run when dimensions, markings, or live state changes

  const handlePointerMove = (e: React.PointerEvent) => {
    const rect = traceCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    // Use client coordinates relative to the bounding rect for better stability
    const x = Math.max(0, Math.min(1000, ((e.clientX - rect.left) / rect.width) * 1000));
    const y = Math.max(0, Math.min(1000, ((e.clientY - rect.top) / rect.height) * 1000));
    
    const now = Date.now();
    const coords = { x, y };
    cursorRef.current = coords;
    setCurrentCoords(coords);

    // Only add to history if distance is enough (MIN_DISTANCE) to reduce jitter
    const lastPoint = cursorHistoryRef.current[cursorHistoryRef.current.length - 1];
    if (lastPoint) {
      const dx = x - lastPoint.x;
      const dy = y - lastPoint.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < MIN_DISTANCE) return;
    }

    cursorHistoryRef.current.push({ x, y, t: now });
    
    // Increase history to 5 seconds to handle transcription latency better
    while (cursorHistoryRef.current.length > 0 && now - cursorHistoryRef.current[0].t > 5000) {
      cursorHistoryRef.current.shift();
    }
  };

  // Global cursor tracking to prevent "stuck" UI cursor
  useEffect(() => {
    const handleGlobalMove = (e: PointerEvent) => {
      setMousePos({ x: e.clientX, y: e.clientY });
      // Only update AI coordinates from global move if we're NOT over the canvas
      // (handlePointerMove takes care of it with higher precision when we are)
      const rect = traceCanvasRef.current?.getBoundingClientRect();
      if (rect) {
        const isOverCanvas = (
          e.clientX >= rect.left && 
          e.clientX <= rect.right && 
          e.clientY >= rect.top && 
          e.clientY <= rect.bottom
        );
        
        if (!isOverCanvas) {
          const x = Math.max(0, Math.min(1000, ((e.clientX - rect.left) / rect.width) * 1000));
          const y = Math.max(0, Math.min(1000, ((e.clientY - rect.top) / rect.height) * 1000));
          const coords = { x, y };
          cursorRef.current = coords;
          setCurrentCoords(coords);
        }
      }
    };
    window.addEventListener('pointermove', handleGlobalMove);
    
    // Global click listener to unlock AudioContext
    const unlockAudio = () => {
      if (audioContextRef.current) {
        audioContextRef.current.resume().then(() => {
          setAudioStatus(audioContextRef.current!.state as any);
        });
      }
    };
    window.addEventListener('click', unlockAudio);
    
    return () => {
      window.removeEventListener('pointermove', handleGlobalMove);
      window.removeEventListener('click', unlockAudio);
    };
  }, []);

  // Vision pipeline
  useEffect(() => {
    if (!isLive) return;
    
    // AI Vision doesn't need full resolution. 400x400 is plenty and much faster to encode.
    const VISION_SIZE = 400;
    const offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = VISION_SIZE; 
    offscreenCanvas.height = VISION_SIZE;
    const ctx = offscreenCanvas.getContext('2d', { alpha: false });

    const interval = setInterval(() => {
      if (!ctx || !traceCanvasRef.current || !persistentCanvasRef.current) return;
      
      // Draw and scale down
      ctx.drawImage(persistentCanvasRef.current, 0, 0, dims.width, dims.height, 0, 0, VISION_SIZE, VISION_SIZE);
      
      // AI Crosshairs (mapped from 0-1000 back to vision canvas pixels)
      const last = cursorRef.current;
      const px = (last.x / 1000) * VISION_SIZE;
      const py = (last.y / 1000) * VISION_SIZE;

      ctx.strokeStyle = 'red';
      ctx.lineWidth = 2; 
      ctx.beginPath();
      ctx.moveTo(0, py); ctx.lineTo(VISION_SIZE, py);
      ctx.moveTo(px, 0); ctx.lineTo(px, VISION_SIZE);
      ctx.stroke();
      
      ctx.beginPath();
      ctx.arc(px, py, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 0, 0, 0.3)';
      ctx.fill();

      ctx.fillStyle = 'red';
      ctx.font = 'bold 12px sans-serif';
      const coordText = `[${Math.round(last.x)}, ${Math.round(last.y)}]`;
      ctx.fillText(coordText, px + 10, py - 10);

      // Encode and send - use toBlob (async) to avoid blocking the main thread
      offscreenCanvas.toBlob((blob) => {
        if (!blob) return;
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(',')[1];
          sessionRef.current?.sendRealtimeInput({ video: { data: base64, mimeType: 'image/jpeg' } });
        };
        reader.readAsDataURL(blob);
      }, 'image/jpeg', 0.6);
    }, sendFrequency);
    return () => clearInterval(interval);
  }, [isLive, sendFrequency, dims]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (transcriptionTimeoutRef.current) clearTimeout(transcriptionTimeoutRef.current);
      if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
    };
  }, []);
  const resetCanvas = () => {
    const ctx = persistentCanvasRef.current?.getContext('2d');
    if(ctx) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = INITIAL_IMAGE;
      img.onload = () => {
        // Use the same cropping logic as initial load
        const imgAspect = img.naturalWidth / img.naturalHeight;
        let sx, sy, sWidth, sHeight;
        if (imgAspect > 1) {
          sHeight = img.naturalHeight;
          sWidth = img.naturalHeight;
          sx = (img.naturalWidth - sWidth) / 2;
          sy = 0;
        } else {
          sWidth = img.naturalWidth;
          sHeight = img.naturalWidth;
          sx = 0;
          sy = (img.naturalHeight - sHeight) / 2;
        }
        
        ctx.clearRect(0, 0, dims.width, dims.height);
        ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, dims.width, dims.height);
        setCurrentImage(persistentCanvasRef.current!.toDataURL('image/png'));
        setInteractiveObjects(INTERACTIVE_OBJECTS);
        setHistory([]); // Clear history on full reset
        addLog('info', 'Canvas Reset.');
        // Clear markers on reset
        markersRef.current = [];
        lastMarkerTimeRef.current = {};
      }
    }
  };

  const handleUndo = () => {
    if (history.length === 0) return;
    
    const lastState = history[history.length - 1];
    setHistory(prev => prev.slice(0, -1));
    
    setCurrentImage(lastState.image);
    setInteractiveObjects(lastState.objects);
    
    const pCanvas = persistentCanvasRef.current;
    if (pCanvas) {
      const ctx = pCanvas.getContext('2d');
      const img = new Image();
      img.onload = () => {
        ctx?.clearRect(0, 0, dims.width, dims.height);
        ctx?.drawImage(img, 0, 0, dims.width, dims.height);
      };
      img.src = lastState.image;
    }
    
    addLog('info', 'Undo performed.');
  };

  if (isMobile || isTabletPortrait) {
    const icon = isDarkMode ? IMAGE_BASE_URL + "not_mobile_2.png" : IMAGE_BASE_URL + "not_mobile.png";
    
    const heading = "We can’t quite fit everything on your screen.";
    const subtext = "please make this window wider and make sure to use a laptop or desktop device.";

    return (
      <div className="fixed inset-0 z-[20000] flex flex-col items-center justify-center p-8 text-center">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-xs flex flex-col items-center"
        >
          <img 
            src={icon} 
            alt="Device Support" 
            className="w-24 h-auto mb-10 object-contain"
            referrerPolicy="no-referrer"
          />
          <div className="space-y-0">
            <h2 className="text-base font-dm font-bold text-[var(--text-primary)] leading-tight">
              {heading}
            </h2>
            <p className="text-[var(--text-secondary)] font-normal mt-2 block">
              {subtext}
            </p>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className={`relative flex flex-col h-screen bg-transparent text-slate-900 dark:text-white overflow-hidden font-sans selection:bg-indigo-500/30 ${isLive ? 'custom-cursor-active' : ''}`}>
      <ThemeToggle isDarkMode={isDarkMode} setIsDarkMode={setIsDarkMode} />
      <div className="flex-1 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden custom-scrollbar">
        <main className="w-full lg:flex-1 flex flex-col items-center justify-center p-4 sm:p-8 relative shrink-0">
          {/* Settings Button */}
          <div className="absolute top-4 left-4 sm:top-8 sm:left-8 z-50 hidden">
            <button 
              onClick={() => setIsSettingsOpen(!isSettingsOpen)}
              className="p-3 bg-transparent border border-[#E5E5E5] rounded-xl hover:bg-slate-50/50 hover:scale-105 active:scale-95 transition-all text-slate-600"
            >
              <Settings size={24} />
            </button>
            
            <AnimatePresence>
              {isSettingsOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -10, scale: 0.95 }}
                  className="absolute top-full left-0 mt-3 w-64 bg-white rounded-xl shadow-2xl border border-black/5 p-4 z-50"
                >
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-xs font-black uppercase tracking-widest text-slate-400">Settings</h3>
                    <button onClick={() => setIsSettingsOpen(false)} className="text-slate-400 hover:text-slate-600">
                      <X size={16} />
                    </button>
                  </div>
                  
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="text-[11px] font-bold text-slate-700">Voice Feedback</span>
                        <span className="text-[9px] text-slate-400">Gemini speaks during loading</span>
                      </div>
                      <button 
                        onClick={() => setEnableVoiceFeedback(!enableVoiceFeedback)}
                        className={`w-10 h-5 rounded-full transition-colors relative ${enableVoiceFeedback ? 'bg-[#1a1a1a]' : 'bg-slate-200'}`}
                      >
                        <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${enableVoiceFeedback ? 'left-6' : 'left-1'}`} />
                      </button>
                    </div>

                    {enableVoiceFeedback && (
                      <div className="flex flex-col gap-3 pt-2">
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-bold text-slate-400 uppercase">Voice Volume</span>
                            <span className="text-[9px] font-bold text-slate-600">{Math.round(voiceVolume * 100)}%</span>
                          </div>
                          <input 
                            type="range" 
                            min="0" 
                            max="1" 
                            step="0.1" 
                            value={voiceVolume} 
                            onChange={(e) => setVoiceVolume(parseFloat(e.target.value))}
                            className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-[#1a1a1a]"
                          />
                        </div>

                        <div className="p-2 bg-slate-50 rounded-lg border border-slate-100 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-bold text-slate-400 uppercase">Voice Diagnostics</span>
                            <div className={`flex items-center gap-1.5`}>
                              <span className="text-[8px] font-medium text-slate-500 uppercase">{audioStatus}</span>
                              <div className={`w-2 h-2 rounded-full ${audioStatus === 'running' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-amber-500 animate-pulse'}`} />
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <button 
                              onClick={() => speakFeedback("testing the voice feedback system")}
                              className="py-1.5 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg text-[9px] font-bold text-slate-600 transition-colors uppercase"
                            >
                              Test Voice
                            </button>
                            <button 
                              onClick={playTestBeep}
                              className="py-1.5 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg text-[9px] font-bold text-slate-600 transition-colors uppercase"
                            >
                              Test Beep
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="relative p-1 bg-gradient-to-b from-white dark:from-slate-700 to-transparent rounded-[1.5rem] sm:rounded-[2.5rem] shadow-[0_40px_100px_rgba(0,0,0,0.1)] dark:shadow-[0_40px_100px_rgba(0,0,0,0.3)] w-full max-w-[min(880px,calc(100vh-180px))] aspect-square shrink-0">
            <div className="relative bg-[var(--card-bg)] rounded-[1.2rem] sm:rounded-[2rem] overflow-hidden w-full h-full">
              <canvas ref={persistentCanvasRef} className="hidden" />
              <img src={currentImage} className="absolute inset-0 w-full h-full pointer-events-none object-cover" alt="Editor" />
              <canvas 
                ref={traceCanvasRef} 
                width={dims.width} 
                height={dims.height} 
                onPointerMove={handlePointerMove}
                className="absolute inset-0 z-10 w-full h-full touch-none"
              />
            </div>
          </div>
        </main>

        {/* Responsive Sidebar */}
        <aside className="w-full lg:w-[400px] p-4 lg:p-6 flex flex-col gap-4 shrink-0 lg:h-full lg:overflow-hidden">
          {/* Task Box - Always Visible */}
          <section className={`shrink-0 relative ${showOnboarding ? 'z-[10001]' : ''}`}>
            <AnimatePresence mode="popLayout" custom={slideDirection}>
              <motion.div
                key={currentTaskIndex}
                custom={slideDirection}
                initial={{ opacity: 0, x: slideDirection * 100 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -slideDirection * 100 }}
                transition={{ type: "spring", damping: 25, stiffness: 200 }}
                className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-2xl p-6 text-[var(--text-primary)] relative overflow-hidden"
              >
                {/* Decorative background element */}
                <div className="absolute -right-4 -top-4 w-24 h-24 bg-indigo-50 dark:bg-indigo-900/20 rounded-full blur-2xl" />
                
                <div className="flex items-center justify-between mb-5 relative z-10">
                  <div className="flex items-center gap-2">
                    <div className="px-3 py-1 rounded-full bg-[#1a1a1a] dark:bg-white text-white dark:text-[#1a1a1a] text-[10px] font-mono font-bold uppercase tracking-widest">
                      {currentTaskIndex < TASKS.length ? `Task ${currentTaskIndex + 1}/${TASKS.length}` : 'Complete'}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button 
                      title="Previous task"
                      onClick={() => {
                        setSlideDirection(-1);
                        const totalCards = allTasksCompleted ? TASKS.length + 1 : TASKS.length;
                        setCurrentTaskIndex(prev => (prev - 1 + totalCards) % totalCards);
                      }}
                      className="p-1.5 rounded-full hover:bg-slate-100 dark:hover:bg-black text-slate-400 transition-colors"
                    >
                      <ChevronLeft size={18} />
                    </button>
                    <button 
                      title="Next task"
                      onClick={() => {
                        setSlideDirection(1);
                        const totalCards = allTasksCompleted ? TASKS.length + 1 : TASKS.length;
                        setCurrentTaskIndex(prev => (prev + 1) % totalCards);
                      }}
                      className="p-1.5 rounded-full hover:bg-slate-100 dark:hover:bg-black text-slate-400 transition-colors"
                    >
                      <ChevronRight size={18} />
                    </button>
                  </div>
                </div>

                {currentTaskIndex < TASKS.length ? (
                  <>
                    <div className="flex gap-4 items-start mb-5 relative z-10">
                      <div className="w-20 h-20 rounded-xl overflow-hidden shrink-0 border border-black/5 dark:border-white/5 shadow-sm bg-slate-50 dark:bg-slate-800">
                        <img 
                          src={TASKS[currentTaskIndex].image} 
                          alt={TASKS[currentTaskIndex].title}
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                          onError={(e) => {
                            // Fallback if the ImgBB direct link guess fails
                            (e.target as HTMLImageElement).src = `https://picsum.photos/seed/${TASKS[currentTaskIndex].id}/200/200`;
                          }}
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-base font-dm font-bold mb-1.5 leading-tight">
                          {TASKS[currentTaskIndex].title}
                        </h4>
                        <p className="text-[13px] font-dm text-slate-500 leading-snug">
                          {TASKS[currentTaskIndex].description}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3 relative z-10">
                      <div className="flex items-center gap-3 bg-[#F8F9FC] dark:bg-[#07182A] px-6 py-4 rounded-xl">
                        {/* Lightbulb Icon */}
                        <Lightbulb size={16} className="text-[#1a1a1a] dark:text-white shrink-0" />
                        
                        <div className="text-xs text-[#1a1a1a] dark:text-white leading-snug font-dm">
                          {/* Label */}
                          <p className="opacity-50 mb-0.5">You can say:</p>
                          
                          {/* Dynamic Hint Text */}
                          <p className="font-bold italic text-sm">
                            {TASKS[currentTaskIndex].hint.match(/"(.*?)"/)?.[0] || ""}
                          </p>
                        </div>
                      </div>

                        <button
                          onClick={() => {
                            if (isCurrentTaskDone) {
                              setCompletedTaskIds(prev => prev.filter(id => id !== TASKS[currentTaskIndex].id));
                              return;
                            }
                            const newCompleted = [...completedTaskIds, TASKS[currentTaskIndex].id];
                            setCompletedTaskIds(newCompleted);
                            confetti({
                              particleCount: 100,
                              spread: 70,
                              origin: { y: 0.6 }
                            });
                            
                            const isAllDone = newCompleted.length === TASKS.length;
                            
                            setTimeout(() => {
                              setSlideDirection(1);
                              setTimeout(() => {
                                const totalCards = isAllDone ? TASKS.length + 1 : TASKS.length;
                                setCurrentTaskIndex(prev => (prev + 1) % totalCards);
                              }, 100);
                            }, 800);
                          }}
                          className={`relative w-full h-[60px] rounded-full font-dm font-bold text-[15px] tracking-[-0.025em] leading-[28px] transition-all flex items-center justify-center active:scale-95 border bg-[var(--card-bg)] ${isCurrentTaskDone ? 'border-slate-300 dark:border-slate-700' : 'border-[var(--card-border)]'} text-[var(--text-primary)] hover:bg-[#E9F0FE] dark:hover:bg-[#304359] hover:border-[#1A74E8] hover:text-[#1A74E8] dark:hover:text-white group`}
                        >
                        <CheckCircle size={18} className={`absolute left-6 ${isCurrentTaskDone ? "text-[#1A74E8]" : "text-slate-300 group-hover:text-[#1A74E8]"}`} />
                        {isCurrentTaskDone ? 'Done' : 'Mark as complete'}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center text-center py-4 relative z-10">
                    <div className="w-20 h-20 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-4">
                      <CheckCircle size={40} className="text-green-600 dark:text-green-400" />
                    </div>
                    <h4 className="text-xl font-dm font-bold mb-2">Congratulations!</h4>
                    <p className="text-sm font-dm text-slate-500 mb-8 max-w-[240px]">
                      You've completed all 4 tasks.<br />Great job!
                    </p>
                    {/* 
                    <button
                      onClick={() => {
                        // Reset or navigate
                        window.location.reload();
                      }}
                      className="relative w-full h-[60px] rounded-full font-dm font-bold text-[15px] tracking-[-0.025em] leading-[28px] transition-all flex items-center justify-center active:scale-95 border border-[var(--card-border)] bg-[var(--card-bg)] text-[var(--text-primary)] hover:bg-[#E9F0FE] dark:hover:bg-[#304359] hover:border-[#1A74E8] hover:text-[#1A74E8] dark:hover:text-white group"
                    >
                      Try another prototype
                    </button>
                    */}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </section>

          {/* Session Controls Box - Buttons */}
          <section className="shrink-0 bg-[var(--card-bg)] border border-[var(--card-border)] rounded-2xl p-6">
            {!isLive ? (
              <button 
                onClick={startLiveSession}
                className="w-full h-[60px] rounded-full font-dm font-bold text-[15px] tracking-[-0.025em] leading-[28px] transition-all shadow-lg bg-[#1A1A1A] dark:bg-white text-white dark:text-[#1A1A1A] hover:bg-[#2A2A2A] dark:hover:bg-slate-200 hover:scale-[1.02] active:scale-98 flex items-center justify-center gap-3"
              >
                <Mic className="w-4 h-4" />
                Start Point and Speak
              </button>
            ) : (
              <div className="flex gap-2">
                <button 
                  onClick={() => sessionRef.current?.close()}
                  className="flex-1 h-[60px] rounded-full font-dm font-bold text-[15px] tracking-[-0.025em] leading-[28px] transition-all shadow-lg bg-[#1A1A1A] dark:bg-white text-white dark:text-[#1A1A1A] hover:bg-[#2A2A2A] dark:hover:bg-slate-200 hover:scale-[1.02] active:scale-98 flex items-center justify-center gap-3"
                >
                  End Session
                </button>
                <button 
                  onClick={handleUndo}
                  disabled={history.length === 0}
                  className={`flex-1 h-[60px] rounded-full font-dm font-bold text-[15px] tracking-[-0.025em] leading-[28px] transition-all flex items-center justify-center active:scale-95 border ${history.length === 0 ? 'bg-slate-50 dark:bg-slate-800 text-slate-300 dark:text-slate-600 border-slate-100 dark:border-slate-700 cursor-not-allowed' : 'bg-[var(--card-bg)] border-[var(--card-border)] text-[var(--text-primary)] hover:bg-[#E9F0FE] dark:hover:bg-blue-900/20 hover:border-[#1A74E8] hover:text-[#1A74E8]'}`}
                >
                  <Undo size={18} className="mr-2" /> Undo
                </button>
              </div>
            )}
          </section>

          {/* Listening Box - Separate Section */}
          <section className="shrink-0 bg-[var(--card-bg)] border border-[var(--card-border)] rounded-2xl p-6 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className={`${(pendingEdit || isProcessing || liveTranscription || isLive) ? 'bg-[#E9F0FE] dark:bg-[#07182A] border-[#1A74E8]' : 'bg-slate-50 dark:bg-[#07182A] border-slate-200 dark:border-slate-700'} border p-5 rounded-2xl flex flex-col gap-4 shadow-sm transition-colors duration-300`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${(pendingEdit || isProcessing || liveTranscription || isLive) ? 'bg-[#1A74E8]' : 'bg-slate-400'} ${isProcessing ? 'animate-spin' : 'animate-pulse-strong'}`} />
                  <span className={`text-[11px] font-mono font-normal tracking-tight ${(pendingEdit || isProcessing || liveTranscription || isLive) ? 'text-[#1A74E8] uppercase' : 'text-[#666666] uppercase'}`}>
                    {isProcessing ? 'Evolving...' : (liveTranscription || pendingEdit || isLive ? 'Listening...' : 'System Idle')}
                  </span>
                </div>
                <span className={`text-[8px] font-mono uppercase opacity-50 ${(pendingEdit || isProcessing || liveTranscription || isLive) ? 'text-[#1a1a1a]' : 'text-[#666666]'}`}>
                  {isProcessing ? 'GPU ACTIVE' : (liveTranscription || pendingEdit ? 'VOICE' : (isLive ? 'READY' : 'OFFLINE'))}
                </span>
              </div>
              
              <p className={`text-[11px] font-mono leading-relaxed ${(pendingEdit || isProcessing || liveTranscription) ? 'text-slate-700 font-normal italic' : 'text-[#666666] font-normal'}`}>
                {liveTranscription || (isLive ? "..." : "Start Point and Speak to begin.")}
              </p>
            </div>
          </section>

          {/* Control Center Box - Minimizable (Hidden for now) */}
          <div className={`hidden flex-col bg-[var(--card-bg)] backdrop-blur-xl border border-[var(--card-border)] shadow-[0_20px_60px_rgba(0,0,0,0.1)] dark:shadow-[0_20px_60px_rgba(0,0,0,0.4)] rounded-2xl overflow-hidden transition-all duration-500 ease-in-out ${isDebugOpen ? 'flex-1' : 'h-[72px] shrink-0'}`}>
            {/* Header with Toggle */}
            <div 
              className="p-6 flex items-center justify-between cursor-pointer hover:bg-slate-50/50 dark:hover:bg-slate-800/50 transition-colors shrink-0"
              onClick={() => setIsDebugOpen(!isDebugOpen)}
            >
              <div className="flex items-center gap-3">
                <div className={`w-2.5 h-2.5 rounded-full ${isLive ? 'bg-green-500 animate-pulse' : 'bg-slate-300 dark:bg-slate-600'}`} />
                <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Control Center</span>
              </div>
              <div className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-400">
                {isDebugOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
              </div>
            </div>

            {isDebugOpen && (
              <div className="px-6 pb-6 flex flex-col h-full space-y-6 overflow-y-auto custom-scrollbar">
                <section className="flex items-center gap-4 bg-slate-50/50 p-4 rounded-2xl border border-black/5">
              <div className="flex-1 min-w-0">
                <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-1">AI Vision State</label>
                <p className="text-[9px] text-slate-400 italic leading-tight mb-2">Magnified view of your target.</p>
                {markersRef.current[0]?.identifiedObject && !["BOTTOM RIGHT AREA", "MONSTER ISLAND", "MIDDLE ISLAND", "LEFT ISLAND", "MONSTER ISLAND (TOP RIGHT)", "MIDDLE ISLAND (CENTER)", "LEFT ISLAND (LEFT SIDE)"].includes(markersRef.current[0].identifiedObject) && (
                  <div className="inline-flex items-center gap-1.5 bg-green-500/10 text-green-600 text-[8px] font-black px-2 py-1 rounded-lg uppercase tracking-widest border border-green-500/20 animate-in fade-in slide-in-from-left-2">
                    <div className="w-1 h-1 rounded-full bg-green-500 animate-pulse" />
                    {markersRef.current[0].identifiedObject}
                  </div>
                )}
              </div>
              <div 
                className="w-20 h-20 shrink-0 bg-slate-100 rounded-xl border border-black/5 overflow-hidden shadow-inner relative"
                style={{
                  backgroundImage: `url(${currentImage})`,
                  backgroundSize: '300%',
                  backgroundPosition: `${((currentCoords.x / 1000) * 3 - 0.5) / 2 * 100}% ${((currentCoords.y / 1000) * 3 - 0.5) / 2 * 100}%`,
                  backgroundRepeat: 'no-repeat',
                }}
              >
                {/* Smooth Crosshair Overlay */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="w-full h-[1px] bg-red-500/30" />
                  <div className="h-full w-[1px] bg-red-500/30 absolute" />
                  <div className="w-4 h-4 border border-red-500/40 rounded-full bg-red-500/5" />
                </div>
                {!isLive && <div className="absolute inset-0 bg-white/80 flex items-center justify-center text-[8px] text-slate-300 uppercase font-black">Offline</div>}
              </div>
            </section>

            <section className="flex-1 min-h-[200px] bg-slate-50 rounded-2xl p-6 border border-black/5 flex flex-col overflow-hidden">
              <span className="text-[9px] font-black uppercase text-slate-400 mb-4 tracking-widest">Operation Stream</span>
              <div className="flex-1 font-mono text-[9px] space-y-3 overflow-y-auto custom-scrollbar pr-2">
                {logs.map((l, i) => (
                  <div key={i} className="flex flex-col gap-1 border-b border-black/5 pb-2">
                    <div className="flex justify-between items-center opacity-40">
                      <span>{l.time}</span>
                      <span className="uppercase text-[7px]">{l.type}</span>
                    </div>
                    <span className={l.type === 'gemini' ? 'text-indigo-600' : 'text-slate-600'}>{l.message}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="flex items-center gap-4 pt-2">
              <div className="flex-1 space-y-2">
                <div className="flex justify-between text-[8px] font-bold text-slate-400 uppercase tracking-widest">
                  <span>Refresh Rate</span>
                  <span>{sendFrequency}ms</span>
                </div>
                <input 
                  type="range" 
                  min="300" 
                  max="2000" 
                  step="100" 
                  value={sendFrequency} 
                  onChange={e => setSendFrequency(Number(e.target.value))} 
                  className="w-full h-1 bg-black/5 rounded-full accent-indigo-500 appearance-none cursor-pointer" 
                />
              </div>
            </section>
          </div>
        )}
      </div>
    </aside>
  </div>

  {/* Custom Cursor */}
  {isLive && (
    <div
      className="fixed top-0 left-0 pointer-events-none z-[40000] hidden sm:block"
      style={{ 
        transform: `translate3d(${mousePos.x}px, ${mousePos.y}px, 0)`,
      }}
    >
      {/* Glow Overlay */}
      <div className="cursor-glow-layer" />

      <svg width="25" height="28" viewBox="0 0 25 28" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ filter: 'drop-shadow(0 0 4px #ADCCF9)' }} className="relative z-10">
        <path d="M3 3 L10 25 L13 18 L22 14 L3 3 Z" fill="white" stroke="#1A73E8" strokeWidth="1.5" shapeRendering="geometricPrecision" />
      </svg>
    </div>
  )}
  
  {/* Welcome Modal */}
  <AnimatePresence>
    {showWelcome && (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
        onClick={handleDismissWelcome}
      >
          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 20 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="bg-[var(--card-bg)] rounded-[32px] shadow-2xl w-full max-w-2xl relative border border-[var(--card-border)] max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col min-h-0 flex-1">
              <div className="pt-6 px-6 pb-0 sm:pt-16 sm:px-16 sm:pb-0 shrink-0">
                <h2 className="text-2xl sm:text-5xl font-inter font-bold text-[var(--text-primary)] mb-4 sm:mb-5 tracking-[-0.04em]">
                  Show and Tell
                  <br />
                  <span className="text-[#1A74E8]">with the AI-Pointer</span>
                </h2>
                <div className="text-slate-500 dark:text-slate-400 font-inter font-normal leading-tight">
                  <p className="m-0">
                    Experience the power of an AI-enabled pointer.
                    <br />
                    Move or edit objects in the image by simply pointing and speaking.
                  </p>
                </div>
              </div>

            <div className="px-6 sm:px-16 mt-2 sm:mt-4 flex-1 min-h-0 flex items-center justify-center">
              <img 
                src={IMAGE_BASE_URL + "welcome_graphic.png"} 
                alt="gPointer Preview" 
                className="max-h-full w-auto block object-contain"
                referrerPolicy="no-referrer"
              />
            </div>
            
            <div className="p-6 sm:p-16 pt-0 -mt-2 sm:-mt-4 shrink-0">
              <button
                onClick={(e) => {
                  handleDismissWelcome(e);
                }}
                className="w-full h-[64px] bg-[#1a1a1a] dark:bg-white text-white dark:text-[#1a1a1a] rounded-full font-dm font-bold text-lg hover:bg-[#2a2a2a] dark:hover:bg-slate-200 transition-all active:scale-[0.98] shadow-lg shadow-black/10 shrink-0 flex items-center justify-center gap-2"
              >
                <Mic className="w-5 h-5" />
                Start Point and Speak
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    )}
  </AnimatePresence>

  {/* Onboarding Overlay */}
  <AnimatePresence>
    {showOnboarding && (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[10000] pointer-events-none"
      >
        {/* Dark Blurred Backdrop */}
        <div 
          className="absolute inset-0 bg-black/40 backdrop-blur-[4px] pointer-events-auto cursor-pointer" 
          onClick={() => setShowOnboarding(false)} 
        />

        {/* Tooltip Box */}
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          className="absolute top-[10%] right-[420px] z-[10002] pointer-events-auto"
        >
          <div className="bg-[var(--card-bg)] border border-[var(--card-border)] text-[var(--text-primary)] p-6 rounded-2xl shadow-2xl max-w-[240px] relative">
            
            {/* Pointer Arrow (Rotated Square) */}
            <div className="absolute top-1/2 -right-2 -translate-y-1/2 w-4 h-4 bg-[var(--card-bg)] border-r border-t border-[var(--card-border)] rotate-45" />
            
            <p className="font-bold text-lg leading-tight mb-2 relative z-10">
              Try to complete these tasks
            </p>
            <p className="text-sm text-[var(--text-secondary)] mb-5 relative z-10">
              Follow the instructions in the task cards to explore the app's features.
            </p>
            
            <button 
              onClick={() => {
                setShowOnboarding(false);
                startLiveSession();
              }}
              className="w-full h-[48px] bg-[var(--inverse-bg)] text-[var(--inverse-text)] rounded-full font-bold text-sm hover:opacity-90 transition-all active:scale-[0.98] shadow-md flex items-center justify-center gap-2 relative z-10"
            >
              <Mic size={18} />
              Start
            </button>
          </div>
        </motion.div>
      </motion.div>
    )}
  </AnimatePresence>
</div>
);
}
