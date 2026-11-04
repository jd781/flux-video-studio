import React, { useRef, useState } from 'react';
import {
  UploadCloud,
  Image as ImageIcon,
  Film,
  Trash2,
  Clock,
  Plus,
  Play,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import {
  DurationSeconds,
  TimelineKeyframe,
  WorkflowMode,
} from '../types/flux';
import { keyframeFrameIndex } from '../utils/flux3';

interface MediaDropzonesProps {
  workflowMode: WorkflowMode;
  duration: DurationSeconds;
  /** Max reference images the selected model accepts. */
  maxReferenceImages?: number;
  /** Max reference videos the selected model accepts. */
  maxReferenceVideos?: number;
  startFrameUrl: string | null;
  endFrameUrl: string | null;
  keyframes: TimelineKeyframe[];
  sourceVideoUrl: string | null;
  sourceVideoName?: string;
  referenceImages?: string[];
  referenceVideos?: string[];
  /** Show the 24 fps frame index next to each timeline pin (FLUX 3 keyframes). */
  showFrameIndex?: boolean;
  onUpdateStartFrame: (url: string | null) => void;
  onUpdateEndFrame: (url: string | null) => void;
  onUpdateKeyframes: (keyframes: TimelineKeyframe[]) => void;
  onUpdateSourceVideo: (url: string | null, name?: string) => void;
  onUpdateReferenceImages?: (images: string[]) => void;
  onUpdateReferenceVideos?: (videos: string[]) => void;
  /** Append a reference tag (e.g. "@Image1") to the prompt. */
  onInsertPromptTag?: (tag: string) => void;
}

const CURATED_SAMPLE_IMAGES = [
  {
    name: 'Cyberpunk Alley',
    url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=800&q=80',
  },
  {
    name: 'Glacial Ridge',
    url: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=800&q=80',
  },
  {
    name: 'Neon Portal',
    url: 'https://images.unsplash.com/photo-1508739773434-c26b3d09e071?auto=format&fit=crop&w=800&q=80',
  },
  {
    name: 'Sci-Fi Corridor',
    url: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=800&q=80',
  },
  {
    name: 'Desert Dunes',
    url: 'https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9?auto=format&fit=crop&w=800&q=80',
  },
];

const CURATED_SAMPLE_VIDEOS = [
  {
    name: 'Blazes Cinematic Sample (15s)',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
  },
  {
    name: 'Escapes Drone Sample (10s)',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
  },
];

export const MediaDropzones: React.FC<MediaDropzonesProps> = ({
  workflowMode,
  duration,
  maxReferenceImages = 10,
  maxReferenceVideos = 10,
  startFrameUrl,
  endFrameUrl,
  keyframes,
  sourceVideoUrl,
  sourceVideoName,
  referenceImages = [],
  referenceVideos = [],
  showFrameIndex = false,
  onUpdateStartFrame,
  onUpdateEndFrame,
  onUpdateKeyframes,
  onUpdateSourceVideo,
  onUpdateReferenceImages,
  onUpdateReferenceVideos,
  onInsertPromptTag,
}) => {
  const startInputRef = useRef<HTMLInputElement>(null);
  const endInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const refVideosInputRef = useRef<HTMLInputElement>(null);
  // Hidden file input used to upload/replace a specific timeline keyframe image.
  const keyframeInputRef = useRef<HTMLInputElement>(null);
  const keyframeUploadTargetRef = useRef<string | null>(null);

  // Opens the file picker to set/replace the image for a given keyframe.
  const triggerKeyframeUpload = (keyframeId: string) => {
    keyframeUploadTargetRef.current = keyframeId;
    keyframeInputRef.current?.click();
  };
  const refImagesInputRef = useRef<HTMLInputElement>(null);

  const [activePresetSlot, setActivePresetSlot] = useState<'start' | 'end' | 'keyframe' | null>(null);
  const [targetKeyframeId, setTargetKeyframeId] = useState<string | null>(null);
  const [showRefPresets, setShowRefPresets] = useState(false);

  const handleMultipleRefImageUploads = (files: File[]) => {
    const currentImages = referenceImages || [];
    const remainingSlots = maxReferenceImages - currentImages.length;
    if (remainingSlots <= 0) return;
    const filesToRead = files.slice(0, remainingSlots);
    const newUrls: string[] = [];
    let loaded = 0;
    filesToRead.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        if (e.target?.result) {
          newUrls.push(e.target.result as string);
        }
        loaded++;
        if (loaded === filesToRead.length) {
          onUpdateReferenceImages?.(
            [...currentImages, ...newUrls].slice(0, maxReferenceImages)
          );
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const handleRemoveRefImage = (index: number) => {
    const updated = (referenceImages || []).filter((_, i) => i !== index);
    onUpdateReferenceImages?.(updated);
  };

  const handleAddPresetRefImage = (url: string) => {
    const current = referenceImages || [];
    if (current.length >= maxReferenceImages) return;
    onUpdateReferenceImages?.([...current, url]);
  };

  // Reference VIDEOS (up to maxReferenceVideos). Each becomes @Video1, @Video2...
  const handleMultipleRefVideoUploads = (files: File[]) => {
    const current = referenceVideos || [];
    const remaining = maxReferenceVideos - current.length;
    if (remaining <= 0) return;
    const toRead = files.slice(0, remaining);
    const newUrls: string[] = [];
    let loaded = 0;
    toRead.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        if (e.target?.result) newUrls.push(e.target.result as string);
        loaded++;
        if (loaded === toRead.length) {
          onUpdateReferenceVideos?.(
            [...current, ...newUrls].slice(0, maxReferenceVideos)
          );
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const handleRemoveRefVideo = (index: number) => {
    onUpdateReferenceVideos?.(
      (referenceVideos || []).filter((_, i) => i !== index)
    );
  };

  // File upload handler helper
  const handleFileUpload = (
    file: File,
    type: 'start' | 'end' | 'video' | 'keyframe',
    keyframeId?: string
  ) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      if (type === 'start') {
        onUpdateStartFrame(dataUrl);
      } else if (type === 'end') {
        onUpdateEndFrame(dataUrl);
      } else if (type === 'video') {
        onUpdateSourceVideo(dataUrl, file.name);
      } else if (type === 'keyframe' && keyframeId) {
        onUpdateKeyframes(
          keyframes.map((kf) => (kf.id === keyframeId ? { ...kf, imageUrl: dataUrl } : kf))
        );
      }
    };
    reader.readAsDataURL(file);
  };

  // Timeline keyframe handlers
  const handleAddKeyframe = () => {
    if (keyframes.length >= 10) return;
    const nextTime = Math.min(
      duration,
      Math.round(((keyframes.length * (duration / 4)) % duration) * 10) / 10
    );
    const newId = `kf-${Date.now()}`;
    const newKf: TimelineKeyframe = {
      id: newId,
      timeSeconds: nextTime,
      imageUrl: '', // no placeholder — user uploads their own image
      label: `Frame ${keyframes.length + 1}`,
      note: `@ ${nextTime}s`,
    };
    const updated = [...keyframes, newKf].sort((a, b) => a.timeSeconds - b.timeSeconds);
    onUpdateKeyframes(updated);
    // Immediately prompt for the image so a new frame isn't left blank.
    triggerKeyframeUpload(newId);
  };

  const handleRemoveKeyframe = (id: string) => {
    onUpdateKeyframes(keyframes.filter((kf) => kf.id !== id));
  };

  const handleUpdateKeyframeTime = (id: string, time: number) => {
    const clamped = Math.max(0, Math.min(duration, time));
    const updated = keyframes
      .map((kf) => (kf.id === id ? { ...kf, timeSeconds: clamped } : kf))
      .sort((a, b) => a.timeSeconds - b.timeSeconds);
    onUpdateKeyframes(updated);
  };

  // If text_to_video, no dropzones are strictly required, but we show a gentle indicator
  if (workflowMode === 'text_to_video') {
    return (
      <div className="p-3.5 rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 text-center">
        <div className="flex items-center justify-center gap-2 text-zinc-400 text-xs mb-1">
          <Sparkles className="w-4 h-4 text-orange-400" />
          <span className="font-medium text-zinc-300">Pure Text Synthesis Active</span>
        </div>
        <p className="text-[11px] text-zinc-500 max-w-xs mx-auto">
Generates scene geometry, lighting, and motion vectors directly from your text prompt. Switch tabs above to anchor images or keyframes.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 1. Start Frame Dropzone (Used in image_to_video & first_last_frame) */}
      {(workflowMode === 'image_to_video' || workflowMode === 'first_last_frame') && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
              <ImageIcon className="w-3.5 h-3.5 text-orange-400" />
              Start Frame <span className="text-zinc-500 text-[10px] font-normal">(Opening anchor)</span>
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setActivePresetSlot(activePresetSlot === 'start' ? null : 'start')}
                className="text-[11px] text-orange-400 hover:text-orange-300 underline underline-offset-2 flex items-center gap-1"
              >
                Sample Presets
              </button>
              {startFrameUrl && (
                <button
                  type="button"
                  onClick={() => onUpdateStartFrame(null)}
                  className="text-[11px] text-zinc-400 hover:text-red-400 flex items-center gap-0.5"
                  title="Clear start frame"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {/* Quick preset selector popover */}
          {activePresetSlot === 'start' && (
            <div className="p-2 bg-zinc-900 border border-zinc-700 rounded-lg grid grid-cols-5 gap-1.5 mb-2">
              {CURATED_SAMPLE_IMAGES.map((sample) => (
                <button
                  key={sample.name}
                  type="button"
                  onClick={() => {
                    onUpdateStartFrame(sample.url);
                    setActivePresetSlot(null);
                  }}
                  className="group relative rounded overflow-hidden aspect-video border border-zinc-700 hover:border-orange-500"
                  title={sample.name}
                >
                  <img src={sample.url} alt={sample.name} className="w-full h-full object-cover" />
                  <span className="absolute inset-0 bg-black/40 group-hover:bg-transparent flex items-end p-0.5 text-[9px] text-white truncate font-medium">
                    {sample.name}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file && file.type.startsWith('image/')) {
                handleFileUpload(file, 'start');
              }
            }}
            onClick={() => !startFrameUrl && startInputRef.current?.click()}
            className={`relative rounded-xl border-2 border-dashed transition-all overflow-hidden cursor-pointer ${
              startFrameUrl
                ? 'border-zinc-700 bg-zinc-900'
                : 'border-zinc-700/80 hover:border-orange-500/70 bg-zinc-950/60 hover:bg-zinc-900/40 p-4 text-center'
            }`}
          >
            <input
              ref={startInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileUpload(file, 'start');
              }}
            />

            {startFrameUrl ? (
              <div className="relative group aspect-video w-full bg-black">
                <img
                  src={startFrameUrl}
                  alt="Start Frame"
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      startInputRef.current?.click();
                    }}
                    className="px-2.5 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-white rounded-md border border-zinc-600"
                  >
                    Replace Image
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onUpdateStartFrame(null);
                    }}
                    className="p-1 bg-red-950 hover:bg-red-900 text-red-300 rounded-md border border-red-800"
                    aria-label="Remove start frame"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="absolute bottom-1.5 left-1.5 bg-black/70 backdrop-blur-xs px-2 py-0.5 rounded text-[10px] text-zinc-300 font-mono">
                  Opening Keyframe (0.0s)
                </div>
              </div>
            ) : (
              <div className="py-2 flex flex-col items-center">
                <div className="w-9 h-9 rounded-full bg-orange-500/10 text-orange-400 flex items-center justify-center mb-1.5">
                  <UploadCloud className="w-5 h-5" />
                </div>
                <p className="text-xs font-medium text-zinc-300">
                  Drop opening image or <span className="text-orange-400">browse</span>
                </p>
                <p className="text-[10px] text-zinc-500 mt-0.5">PNG, JPG, WebP up to 25MB</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 2. End Frame Dropzone (First + Last Frame mode) */}
      {workflowMode === 'first_last_frame' && (
        <div className="space-y-1.5 pt-1 border-t border-zinc-800/80">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
              <ImageIcon className="w-3.5 h-3.5 text-amber-400" />
              End Frame <span className="text-zinc-500 text-[10px] font-normal">(Target ending @ {duration}s)</span>
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setActivePresetSlot(activePresetSlot === 'end' ? null : 'end')}
                className="text-[11px] text-amber-400 hover:text-amber-300 underline underline-offset-2 flex items-center gap-1"
              >
                Sample Presets
              </button>
              {endFrameUrl && (
                <button
                  type="button"
                  onClick={() => onUpdateEndFrame(null)}
                  className="text-[11px] text-zinc-400 hover:text-red-400 flex items-center gap-0.5"
                  title="Clear end frame"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {activePresetSlot === 'end' && (
            <div className="p-2 bg-zinc-900 border border-zinc-700 rounded-lg grid grid-cols-5 gap-1.5 mb-2">
              {CURATED_SAMPLE_IMAGES.map((sample) => (
                <button
                  key={sample.name}
                  type="button"
                  onClick={() => {
                    onUpdateEndFrame(sample.url);
                    setActivePresetSlot(null);
                  }}
                  className="group relative rounded overflow-hidden aspect-video border border-zinc-700 hover:border-amber-500"
                  title={sample.name}
                >
                  <img src={sample.url} alt={sample.name} className="w-full h-full object-cover" />
                  <span className="absolute inset-0 bg-black/40 group-hover:bg-transparent flex items-end p-0.5 text-[9px] text-white truncate font-medium">
                    {sample.name}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file && file.type.startsWith('image/')) {
                handleFileUpload(file, 'end');
              }
            }}
            onClick={() => !endFrameUrl && endInputRef.current?.click()}
            className={`relative rounded-xl border-2 border-dashed transition-all overflow-hidden cursor-pointer ${
              endFrameUrl
                ? 'border-zinc-700 bg-zinc-900'
                : 'border-zinc-700/80 hover:border-amber-500/70 bg-zinc-950/60 hover:bg-zinc-900/40 p-4 text-center'
            }`}
          >
            <input
              ref={endInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileUpload(file, 'end');
              }}
            />

            {endFrameUrl ? (
              <div className="relative group aspect-video w-full bg-black">
                <img
                  src={endFrameUrl}
                  alt="End Frame"
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      endInputRef.current?.click();
                    }}
                    className="px-2.5 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-white rounded-md border border-zinc-600"
                  >
                    Replace Image
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onUpdateEndFrame(null);
                    }}
                    className="p-1 bg-red-950 hover:bg-red-900 text-red-300 rounded-md border border-red-800"
                    aria-label="Remove end frame"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="absolute bottom-1.5 left-1.5 bg-black/70 backdrop-blur-xs px-2 py-0.5 rounded text-[10px] text-zinc-300 font-mono">
                  Final Keyframe ({duration}.0s)
                </div>
              </div>
            ) : (
              <div className="py-2 flex flex-col items-center">
                <div className="w-9 h-9 rounded-full bg-amber-500/10 text-amber-400 flex items-center justify-center mb-1.5">
                  <UploadCloud className="w-5 h-5" />
                </div>
                <p className="text-xs font-medium text-zinc-300">
                  Drop target ending image or <span className="text-amber-400">browse</span>
                </p>
                <p className="text-[10px] text-zinc-500 mt-0.5">
                  Interpolates lighting & camera motion to reach this frame
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 3. Reference Timeline Mode (Up to 10 anchored frames with timestamps) */}
      {workflowMode === 'keyframes_timeline' && (
        <div className="space-y-2.5">
          {/* Hidden input that uploads an image into the targeted keyframe. */}
          <input
            ref={keyframeInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              const target = keyframeUploadTargetRef.current;
              if (file && target) {
                handleFileUpload(file, 'keyframe', target);
              }
              keyframeUploadTargetRef.current = null;
              e.target.value = ''; // allow re-selecting the same file
            }}
          />
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-cyan-400" />
              Reference Timeline
              <span className="text-zinc-500 text-[10px] font-normal">
                ({keyframes.length}/10 anchored frames)
              </span>
            </span>
            <button
              type="button"
              onClick={handleAddKeyframe}
              disabled={keyframes.length >= 10}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-cyan-950/80 hover:bg-cyan-900 text-cyan-300 border border-cyan-800 text-[11px] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus className="w-3 h-3" /> Add Frame
            </button>
          </div>

          {/* Visual Timeline Bar */}
          <div className="bg-zinc-900/90 border border-zinc-800 p-2.5 rounded-xl space-y-2">
            <div className="relative h-6 bg-zinc-950 rounded-lg border border-zinc-800 flex items-center px-2">
              {/* Timeline markings */}
              <div className="absolute inset-0 flex justify-between px-2 text-[9px] font-mono text-zinc-600 items-center pointer-events-none">
                <span>0s</span>
                <span>{Math.round(duration * 0.25)}s</span>
                <span>{Math.round(duration * 0.5)}s</span>
                <span>{Math.round(duration * 0.75)}s</span>
                <span>{duration}s</span>
              </div>

              {/* Pin markers */}
              {keyframes.map((kf, idx) => {
                const percent = Math.min(100, Math.max(0, (kf.timeSeconds / duration) * 100));
                return (
                  <div
                    key={kf.id}
                    style={{ left: `calc(${percent}% - 8px)` }}
                    className="absolute z-10 flex flex-col items-center group cursor-pointer"
                    title={`Frame #${idx + 1}: ${kf.timeSeconds}s`}
                  >
                    <div className="w-4 h-4 rounded-full bg-cyan-500 border-2 border-zinc-950 shadow-md group-hover:scale-125 transition-transform flex items-center justify-center text-[8px] font-bold text-black">
                      {idx + 1}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Anchored Frames List */}
            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {keyframes.map((kf, index) => (
                <div
                  key={kf.id}
                  className="flex items-center gap-2 p-1.5 bg-zinc-950 rounded-lg border border-zinc-800 hover:border-zinc-700"
                >
                  {/* Thumbnail — click to upload / replace */}
                  <button
                    type="button"
                    onClick={() => triggerKeyframeUpload(kf.id)}
                    className="w-14 h-10 rounded overflow-hidden bg-black flex-shrink-0 relative group/kf border border-transparent hover:border-cyan-400 transition-colors"
                    title={kf.imageUrl ? 'Replace image' : 'Upload image'}
                  >
                    {kf.imageUrl ? (
                      <img
                        src={kf.imageUrl}
                        alt={kf.label || `Frame ${index + 1}`}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="w-full h-full flex flex-col items-center justify-center text-cyan-300/70 bg-zinc-900">
                        <UploadCloud className="w-3.5 h-3.5" />
                      </span>
                    )}
                    <span className="absolute top-0.5 left-0.5 bg-black/80 text-[8px] text-cyan-300 font-mono px-1 rounded">
                      #{index + 1}
                    </span>
                    {kf.imageUrl && (
                      <span className="absolute inset-0 bg-black/50 opacity-0 group-hover/kf:opacity-100 transition-opacity flex items-center justify-center">
                        <UploadCloud className="w-3.5 h-3.5 text-white" />
                      </span>
                    )}
                  </button>

                  {/* Timestamp & Label */}
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-zinc-500 font-mono">Pin:</span>
                      <input
                        type="number"
                        min="0"
                        max={duration}
                        step="0.5"
                        value={kf.timeSeconds}
                        onChange={(e) =>
                          handleUpdateKeyframeTime(kf.id, parseFloat(e.target.value) || 0)
                        }
                        className="w-14 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-white font-mono"
                      />
                      <span className="text-[10px] text-zinc-500">s</span>
                      {showFrameIndex && (
                        <span
                          className="text-[10px] text-cyan-400/80 font-mono whitespace-nowrap"
                          title="Frame index sent to FLUX 3 (24 fps)"
                        >
                          f{keyframeFrameIndex(kf.timeSeconds, duration)}
                        </span>
                      )}
                    </div>

                    <input
                      type="text"
                      value={kf.label || ''}
                      placeholder="Scene note / cue..."
                      onChange={(e) => {
                        const updated = keyframes.map((item) =>
                          item.id === kf.id ? { ...item, label: e.target.value } : item
                        );
                        onUpdateKeyframes(updated);
                      }}
                      className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5 text-[11px] text-zinc-200"
                    />
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => triggerKeyframeUpload(kf.id)}
                      className="text-[10px] text-zinc-400 hover:text-cyan-300 px-1 py-0.5 bg-zinc-900 rounded"
                      title="Upload / replace image"
                    >
                      Upload
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTargetKeyframeId(targetKeyframeId === kf.id ? null : kf.id);
                      }}
                      className="text-[10px] text-zinc-400 hover:text-cyan-300 px-1 py-0.5 bg-zinc-900 rounded"
                      title="Choose a sample preset"
                    >
                      Presets
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveKeyframe(kf.id)}
                      className="p-1 text-zinc-500 hover:text-red-400"
                      aria-label="Remove keyframe"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Swap preset chooser */}
            {targetKeyframeId && (
              <div className="p-2 bg-zinc-900 border border-cyan-800/80 rounded-lg">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[10px] text-cyan-300 font-medium">
                    Sample presets (or upload your own):
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const target = targetKeyframeId;
                      setTargetKeyframeId(null);
                      if (target) triggerKeyframeUpload(target);
                    }}
                    className="flex items-center gap-1 text-[10px] text-cyan-300 hover:text-cyan-200 px-1.5 py-0.5 bg-cyan-950/60 border border-cyan-800 rounded"
                  >
                    <UploadCloud className="w-3 h-3" /> Upload
                  </button>
                </div>
                <div className="grid grid-cols-5 gap-1.5">
                  {CURATED_SAMPLE_IMAGES.map((sample) => (
                    <button
                      key={sample.name}
                      type="button"
                      onClick={() => {
                        onUpdateKeyframes(
                          keyframes.map((kf) =>
                            kf.id === targetKeyframeId ? { ...kf, imageUrl: sample.url } : kf
                          )
                        );
                        setTargetKeyframeId(null);
                      }}
                      className="aspect-video rounded overflow-hidden border border-zinc-700 hover:border-cyan-400"
                    >
                      <img src={sample.url} alt={sample.name} className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 4. Source Clip Dropzone (Video Extend / Edit) */}
      {workflowMode === 'video_extend' && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
              <Film className="w-3.5 h-3.5 text-purple-400" />
              Source Video Clip{' '}
              <span className="text-zinc-500 text-[10px] font-normal">
                (MP4 to extend / restyle)
              </span>
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() =>
                  onUpdateSourceVideo(CURATED_SAMPLE_VIDEOS[0].url, CURATED_SAMPLE_VIDEOS[0].name)
                }
                className="text-[11px] text-purple-400 hover:text-purple-300 underline underline-offset-2"
              >
                Sample Clip
              </button>
              {sourceVideoUrl && (
                <button
                  type="button"
                  onClick={() => onUpdateSourceVideo(null)}
                  className="text-[11px] text-zinc-400 hover:text-red-400"
                  title="Clear video"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file && file.type.startsWith('video/')) {
                handleFileUpload(file, 'video');
              }
            }}
            onClick={() => !sourceVideoUrl && videoInputRef.current?.click()}
            className={`relative rounded-xl border-2 border-dashed transition-all overflow-hidden cursor-pointer ${
              sourceVideoUrl
                ? 'border-purple-800/80 bg-zinc-900'
                : 'border-zinc-700/80 hover:border-purple-500/70 bg-zinc-950/60 hover:bg-zinc-900/40 p-4 text-center'
            }`}
          >
            <input
              ref={videoInputRef}
              type="file"
              accept="video/mp4,video/webm"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileUpload(file, 'video');
              }}
            />

            {sourceVideoUrl ? (
              <div className="relative group p-2">
                <div className="aspect-video bg-black rounded-lg overflow-hidden relative">
                  <video
                    src={sourceVideoUrl}
                    controls
                    className="w-full h-full object-contain"
                  />
                </div>
                <div className="flex items-center justify-between mt-2 text-[11px] text-zinc-300">
                  <span className="truncate max-w-[200px] font-mono text-purple-300">
                    {sourceVideoName || 'Uploaded Video.mp4'}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        videoInputRef.current?.click();
                      }}
                      className="px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded border border-zinc-700 text-[10px]"
                    >
                      Change
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onUpdateSourceVideo(null);
                      }}
                      className="p-1 text-red-400 hover:text-red-300"
                      aria-label="Remove video"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-2 flex flex-col items-center">
                <div className="w-9 h-9 rounded-full bg-purple-500/10 text-purple-400 flex items-center justify-center mb-1.5">
                  <UploadCloud className="w-5 h-5" />
                </div>
                <p className="text-xs font-medium text-zinc-300">
                  Drop existing video (.mp4) or <span className="text-purple-400">browse</span>
                </p>
                <p className="text-[10px] text-zinc-500 mt-0.5">
                  Analyzes motion vectors and extends the clip smoothly
                </p>
              </div>
            )}
          </div>

          {/* Reference Images Dropzone (Up to 10 images) */}
          <div className="space-y-1.5 pt-2 border-t border-zinc-800/80">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
                <ImageIcon className="w-3.5 h-3.5 text-cyan-400" />
                Reference Images
                <span className="text-zinc-500 text-[10px] font-normal font-mono">
                  ({(referenceImages || []).length}/{maxReferenceImages} max)
                </span>
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setShowRefPresets(!showRefPresets)}
                  className="text-[11px] text-cyan-400 hover:text-cyan-300 underline underline-offset-2 flex items-center gap-1"
                >
                  Sample Presets
                </button>
                {(referenceImages || []).length > 0 && (
                  <button
                    type="button"
                    onClick={() => onUpdateReferenceImages?.([])}
                    className="text-[11px] text-zinc-400 hover:text-red-400"
                    title="Clear all reference images"
                  >
                    Clear All
                  </button>
                )}
              </div>
            </div>

            {/* Quick sample presets */}
            {showRefPresets && (
              <div className="p-2 bg-zinc-900 border border-cyan-800/60 rounded-lg">
                <div className="text-[10px] text-cyan-300 font-medium mb-1">
                  Click to add sample reference asset:
                </div>
                <div className="grid grid-cols-5 gap-1.5">
                  {CURATED_SAMPLE_IMAGES.map((sample) => (
                    <button
                      key={sample.name}
                      type="button"
                      disabled={(referenceImages || []).length >= maxReferenceImages}
                      onClick={() => handleAddPresetRefImage(sample.url)}
                      className="aspect-video rounded overflow-hidden border border-zinc-700 hover:border-cyan-400 disabled:opacity-40"
                      title={sample.name}
                    >
                      <img src={sample.url} alt={sample.name} className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Drag & drop multi-image container */}
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const files = Array.from(e.dataTransfer.files).filter((f) =>
                  f.type.startsWith('image/')
                );
                if (files.length > 0) {
                  handleMultipleRefImageUploads(files);
                }
              }}
              className="rounded-xl border-2 border-dashed border-zinc-800 bg-zinc-950/60 p-2.5 transition-all space-y-2"
            >
              <input
                ref={refImagesInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = e.target.files;
                  if (files && files.length > 0) {
                    handleMultipleRefImageUploads(Array.from(files));
                  }
                }}
              />

              {/* Grid of reference image thumbnails */}
              {(referenceImages || []).length > 0 ? (
                <div className="grid grid-cols-5 gap-1.5">
                  {(referenceImages || []).map((imgUrl, idx) => (
                    <div
                      key={`ref-${idx}`}
                      className="relative group aspect-square rounded-lg overflow-hidden border border-zinc-700 bg-black"
                    >
                      <img
                        src={imgUrl}
                        alt={`Reference #${idx + 1}`}
                        className="w-full h-full object-cover"
                      />
                      <span className="absolute top-0.5 left-0.5 bg-black/80 text-[8px] font-mono text-cyan-300 px-1 rounded">
                        #{idx + 1}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRemoveRefImage(idx)}
                        className="absolute top-0.5 right-0.5 p-0.5 rounded bg-black/80 hover:bg-red-950 text-zinc-300 hover:text-red-300 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Remove reference image"
                        aria-label={`Remove reference image #${idx + 1}`}
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  ))}

                  {/* Add more button if under the model's limit */}
                  {(referenceImages || []).length < maxReferenceImages && (
                    <button
                      type="button"
                      onClick={() => refImagesInputRef.current?.click()}
                      className="aspect-square rounded-lg border border-dashed border-zinc-700 hover:border-cyan-500 bg-zinc-900/50 hover:bg-zinc-800 flex flex-col items-center justify-center text-zinc-400 hover:text-cyan-300 transition-colors"
                      title="Add more reference images"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span className="text-[9px] font-medium mt-0.5">Add</span>
                    </button>
                  )}
                </div>
              ) : (
                <div
                  onClick={() => refImagesInputRef.current?.click()}
                  className="py-3 flex flex-col items-center cursor-pointer hover:bg-zinc-900/40 rounded-lg transition-colors"
                >
                  <div className="w-8 h-8 rounded-full bg-cyan-500/10 text-cyan-400 flex items-center justify-center mb-1">
                    <UploadCloud className="w-4 h-4" />
                  </div>
                  <p className="text-xs font-medium text-zinc-300">
                    Drop up to {maxReferenceImages} reference images or{' '}
                    <span className="text-cyan-400">browse</span>
                  </p>
                  <p className="text-[10px] text-zinc-500 mt-0.5">
                    Guides visual consistency, character likeness, or environment styling
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 5. Reference to Video (Seedance 2.5): multi-image + multi-video refs */}
      {workflowMode === 'reference_to_video' && (
        <div className="space-y-3">
          {/* Reference Images */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
                <ImageIcon className="w-3.5 h-3.5 text-cyan-400" />
                Reference Images
                <span className="text-zinc-500 text-[10px] font-normal font-mono">
                  ({referenceImages.length}/{maxReferenceImages})
                </span>
              </span>
              {referenceImages.length > 0 && (
                <button
                  type="button"
                  onClick={() => onUpdateReferenceImages?.([])}
                  className="text-[11px] text-zinc-400 hover:text-red-400"
                >
                  Clear
                </button>
              )}
            </div>
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const files = Array.from(e.dataTransfer.files).filter((f) =>
                  f.type.startsWith('image/')
                );
                if (files.length > 0) handleMultipleRefImageUploads(files);
              }}
              className="rounded-xl border-2 border-dashed border-zinc-800 bg-zinc-950/60 p-2.5"
            >
              <input
                ref={refImagesInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = e.target.files;
                  if (files && files.length > 0)
                    handleMultipleRefImageUploads(Array.from(files));
                }}
              />
              {referenceImages.length > 0 ? (
                <div className="grid grid-cols-5 gap-1.5">
                  {referenceImages.map((imgUrl, idx) => (
                    <button
                      key={`refimg-${idx}`}
                      type="button"
                      onClick={() => onInsertPromptTag?.(`@Image${idx + 1}`)}
                      className="relative group aspect-square rounded-lg overflow-hidden border border-zinc-700 hover:border-cyan-400 bg-black transition-colors"
                      title={`Insert @Image${idx + 1} into prompt`}
                    >
                      <img src={imgUrl} alt={`Reference image ${idx + 1}`} className="w-full h-full object-cover" />
                      <span className="absolute top-0.5 left-0.5 bg-black/80 text-[8px] font-mono text-cyan-300 px-1 rounded">
                        @Image{idx + 1}
                      </span>
                      <span className="absolute inset-0 bg-cyan-500/0 group-hover:bg-cyan-500/10 transition-colors" />
                      <span
                        role="button"
                        tabIndex={-1}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveRefImage(idx);
                        }}
                        className="absolute top-0.5 right-0.5 p-0.5 rounded bg-black/80 hover:bg-red-950 text-zinc-300 hover:text-red-300 opacity-0 group-hover:opacity-100 transition-opacity"
                        aria-label={`Remove reference image ${idx + 1}`}
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                      </span>
                    </button>
                  ))}
                  {referenceImages.length < maxReferenceImages && (
                    <button
                      type="button"
                      onClick={() => refImagesInputRef.current?.click()}
                      className="aspect-square rounded-lg border border-dashed border-zinc-700 hover:border-cyan-500 bg-zinc-900/50 hover:bg-zinc-800 flex flex-col items-center justify-center text-zinc-400 hover:text-cyan-300"
                      title="Add reference images"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span className="text-[9px] font-medium mt-0.5">Add</span>
                    </button>
                  )}
                </div>
              ) : (
                <div
                  onClick={() => refImagesInputRef.current?.click()}
                  className="py-3 flex flex-col items-center cursor-pointer hover:bg-zinc-900/40 rounded-lg transition-colors"
                >
                  <div className="w-8 h-8 rounded-full bg-cyan-500/10 text-cyan-400 flex items-center justify-center mb-1">
                    <UploadCloud className="w-4 h-4" />
                  </div>
                  <p className="text-xs font-medium text-zinc-300">
                    Drop up to {maxReferenceImages} images or{' '}
                    <span className="text-cyan-400">browse</span>
                  </p>
                  <p className="text-[10px] text-zinc-500 mt-0.5">
                    Click a thumbnail to insert @Image1, @Image2, … into the prompt
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Reference Videos */}
          <div className="space-y-1.5 pt-2 border-t border-zinc-800/80">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
                <Film className="w-3.5 h-3.5 text-purple-400" />
                Reference Videos
                <span className="text-zinc-500 text-[10px] font-normal font-mono">
                  ({referenceVideos.length}/{maxReferenceVideos})
                </span>
              </span>
              {referenceVideos.length > 0 && (
                <button
                  type="button"
                  onClick={() => onUpdateReferenceVideos?.([])}
                  className="text-[11px] text-zinc-400 hover:text-red-400"
                >
                  Clear
                </button>
              )}
            </div>
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const files = Array.from(e.dataTransfer.files).filter((f) =>
                  f.type.startsWith('video/')
                );
                if (files.length > 0) handleMultipleRefVideoUploads(files);
              }}
              className="rounded-xl border-2 border-dashed border-zinc-800 bg-zinc-950/60 p-2.5"
            >
              <input
                ref={refVideosInputRef}
                type="file"
                accept="video/mp4,video/quicktime,video/webm"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = e.target.files;
                  if (files && files.length > 0)
                    handleMultipleRefVideoUploads(Array.from(files));
                }}
              />
              {referenceVideos.length > 0 ? (
                <div className="grid grid-cols-3 gap-1.5">
                  {referenceVideos.map((vidUrl, idx) => (
                    <button
                      key={`refvid-${idx}`}
                      type="button"
                      onClick={() => onInsertPromptTag?.(`@Video${idx + 1}`)}
                      className="relative group aspect-video rounded-lg overflow-hidden border border-zinc-700 hover:border-purple-400 bg-black transition-colors"
                      title={`Insert @Video${idx + 1} into prompt`}
                    >
                      <video src={vidUrl} muted playsInline className="w-full h-full object-cover" />
                      <span className="absolute top-0.5 left-0.5 bg-black/80 text-[8px] font-mono text-purple-300 px-1 rounded">
                        @Video{idx + 1}
                      </span>
                      <span className="absolute inset-0 bg-purple-500/0 group-hover:bg-purple-500/10 transition-colors" />
                      <span
                        role="button"
                        tabIndex={-1}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveRefVideo(idx);
                        }}
                        className="absolute top-0.5 right-0.5 p-0.5 rounded bg-black/80 hover:bg-red-950 text-zinc-300 hover:text-red-300 opacity-0 group-hover:opacity-100 transition-opacity"
                        aria-label={`Remove reference video ${idx + 1}`}
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                      </span>
                    </button>
                  ))}
                  {referenceVideos.length < maxReferenceVideos && (
                    <button
                      type="button"
                      onClick={() => refVideosInputRef.current?.click()}
                      className="aspect-video rounded-lg border border-dashed border-zinc-700 hover:border-purple-500 bg-zinc-900/50 hover:bg-zinc-800 flex flex-col items-center justify-center text-zinc-400 hover:text-purple-300"
                      title="Add reference videos"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span className="text-[9px] font-medium mt-0.5">Add</span>
                    </button>
                  )}
                </div>
              ) : (
                <div
                  onClick={() => refVideosInputRef.current?.click()}
                  className="py-3 flex flex-col items-center cursor-pointer hover:bg-zinc-900/40 rounded-lg transition-colors"
                >
                  <div className="w-8 h-8 rounded-full bg-purple-500/10 text-purple-400 flex items-center justify-center mb-1">
                    <UploadCloud className="w-4 h-4" />
                  </div>
                  <p className="text-xs font-medium text-zinc-300">
                    Drop up to {maxReferenceVideos} videos (.mp4/.mov) or{' '}
                    <span className="text-purple-400">browse</span>
                  </p>
                  <p className="text-[10px] text-zinc-500 mt-0.5">
                    Click a thumbnail to insert @Video1, @Video2, … • combined ≤ 30s
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
