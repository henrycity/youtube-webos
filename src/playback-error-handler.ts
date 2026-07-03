import { getPlayerManager } from './player_api';
import type { EventMapOf, PlayerManager } from './player_api';
import type { PlayerStateObject } from './player_api/yt-api';

const playerManager = await getPlayerManager();

type EventMap = EventMapOf<PlayerManager>;

let currentVideo: HTMLVideoElement | null = null;
let bufferingStartTime: number | null = null;
let lastPlayerState: PlayerStateObject | null = null;
let errorOccurrenceTime: number | null = null;
let consecutiveFalsePositiveCount = 0; // Track consecutive false positives
let lastRecoveryAttemptTime: number | null = null;
const BUFFERING_TIMEOUT_MS = 15000; // 15 seconds - max time to wait for buffering to complete
const MIN_TIME_BETWEEN_RECOVERY_MS = 5000; // Minimum 5 seconds between recovery attempts

function getVideoElementState(video: HTMLVideoElement) {
  try {
    const readyStateNames = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
    const networkStateNames = ['NETWORK_EMPTY', 'NETWORK_IDLE', 'NETWORK_LOADING', 'NETWORK_NO_SOURCE'];
    
    // Helper to safely format timing values
    const formatTime = (time: number): string => {
      if (!isFinite(time)) return 'N/A';
      return time.toFixed(2);
    };
    
    let bufferedInfo = '';
    try {
      if (video.buffered.length > 0 && isFinite(video.duration) && video.duration > 0) {
        const lastBuffer = video.buffered.length - 1;
        const bufferedEnd = video.buffered.end(lastBuffer);
        const percentBuffered = ((bufferedEnd / video.duration) * 100).toFixed(1);
        bufferedInfo = `${percentBuffered}% (${formatTime(bufferedEnd)}s/${formatTime(video.duration)}s)`;
      } else {
        bufferedInfo = '0%';
      }
    } catch {
      bufferedInfo = 'error';
    }
    
    return {
      readyState: `${video.readyState} (${readyStateNames[video.readyState] || 'UNKNOWN'})`,
      networkState: `${video.networkState} (${networkStateNames[video.networkState] || 'UNKNOWN'})`,
      paused: video.paused,
      currentTime: formatTime(video.currentTime),
      duration: formatTime(video.duration),
      buffered: bufferedInfo,
      src: video.src ? '(has src)' : '(no src)',
      sourceCount: Array.from(video.children).filter(c => c.tagName === 'SOURCE').length
    };
  } catch (e) {
    return { error: String(e) };
  }
}

function handleVideoError(this: HTMLVideoElement) {
  const err = this.error;
  console.error(
    `[playback-error-handler] Video element error ${JSON.stringify({
      error: err ? { code: err.code, message: err.message } : null,
      videoState: getVideoElementState(this)
    })}`
  );
}

function handleVideoAbort(this: HTMLVideoElement) {
  console.warn('[playback-error-handler] Video playback aborted');
}

function handleVideoStalled(this: HTMLVideoElement) {
  console.warn('[playback-error-handler] Video playback stalled');
}

function attachVideoListeners(video: HTMLVideoElement) {
  video.addEventListener('error', handleVideoError);
  video.addEventListener('abort', handleVideoAbort);
  video.addEventListener('stalled', handleVideoStalled);
}

function detachVideoListeners(video: HTMLVideoElement) {
  video.removeEventListener('error', handleVideoError);
  video.removeEventListener('abort', handleVideoAbort);
  video.removeEventListener('stalled', handleVideoStalled);
}

function handleNewVideo(this: PlayerManager, _: EventMap['newVideo']) {
  if (currentVideo) {
    detachVideoListeners(currentVideo);
  }
  const video = document.querySelector('video');
  if (video) {
    currentVideo = video;
    attachVideoListeners(video);
    // Reset all tracking state for the new video to ensure clean state
    // This prevents false positive counts and buffering timeouts from previous
    // videos from affecting the new video playback
    consecutiveFalsePositiveCount = 0;
    errorOccurrenceTime = null;
    lastRecoveryAttemptTime = null;
    bufferingStartTime = null;
  }
}

function handlePlaybackError(this: PlayerManager, event: EventMap['playbackError']) {
  const videoData = this.player.getVideoData();
  const playerState = this.player.getPlayerStateObject();
  const videoErr = currentVideo?.error;
  const videoElementState = currentVideo ? getVideoElementState(currentVideo) : null;
  
  // Track state changes to detect error patterns
  if (lastPlayerState === null) {
    lastPlayerState = playerState;
  }
  
  const stateChanges: string[] = [];
  // After the check above, lastPlayerState is guaranteed to be non-null
  const prevState = lastPlayerState;
  (Object.keys(playerState) as Array<keyof PlayerStateObject>).forEach(key => {
    if (prevState[key] !== playerState[key]) {
      stateChanges.push(`${key}: ${prevState[key]} -> ${playerState[key]}`);
    }
  });
  lastPlayerState = playerState;

  const errorInfo = {
    videoId: videoData.video_id,
    title: videoData.title,
    playerState,
    videoError: videoErr ? { code: videoErr.code, message: videoErr.message } : null,
    videoElement: videoElementState,
    stateChanges: stateChanges.length > 0 ? stateChanges : undefined
  };

  // Log the event object from the callback for debugging
  console.error(
    `[playback-error-handler] Playback error event ${JSON.stringify({
      type: event.type,
      detail: event.detail,
      currentTarget: event.currentTarget?.constructor?.name ?? null
    })}`
  );

  // If the video has ended naturally, this is not an error - just log and return
  if (playerState.isEnded) {
    console.info('[playback-error-handler] Video has ended naturally, not treating as error');
    errorOccurrenceTime = null;
    return;
  }

  // If the video is currently buffering, check if it's been buffering too long
  if (playerState.isBuffering) {
    const now = Date.now();
    
    // First time seeing buffering state
    if (bufferingStartTime === null) {
      bufferingStartTime = now;
      console.info('[playback-error-handler] Video started buffering');
      return;
    }
    
    const bufferingDuration = now - bufferingStartTime;
    
    // If buffering is taking too long, it's probably stuck - attempt recovery
    if (bufferingDuration > BUFFERING_TIMEOUT_MS) {
      console.warn(
        `[playback-error-handler] Video has been buffering for ${bufferingDuration}ms (timeout: ${BUFFERING_TIMEOUT_MS}ms), attempting recovery ${JSON.stringify({
          videoId: videoData.video_id,
          currentTime: currentVideo?.currentTime ?? 'N/A',
          duration: currentVideo?.duration ?? 'N/A'
        })}`
      );
      bufferingStartTime = null;
      // Fall through to attempt recovery
    } else {
      // Buffering is still within normal timeframe, wait for it to complete
      console.info('[playback-error-handler] Video is buffering (duration: ' + bufferingDuration + 'ms), waiting...');
      return;
    }
  } else {
    // Video is no longer buffering - reset the timer
    if (bufferingStartTime !== null) {
      console.info('[playback-error-handler] Video finished buffering');
      bufferingStartTime = null;
    }
  }

  // If there's no actual video element error (videoError is null) but the player
  // thinks there's an error, this is likely a false positive caused by SABR backoff.
  // Attempt recovery by resuming playback without reloading the video.
  if (!videoErr) {
    const now = Date.now();
    const timeSinceLastError = errorOccurrenceTime !== null ? now - errorOccurrenceTime : null;
    const timeSinceLastRecovery = lastRecoveryAttemptTime !== null ? now - lastRecoveryAttemptTime : null;
    
    // Track consecutive false positives
    consecutiveFalsePositiveCount++;
    
    const shouldAttemptRecovery = lastRecoveryAttemptTime === null || 
      (timeSinceLastRecovery !== null && timeSinceLastRecovery >= MIN_TIME_BETWEEN_RECOVERY_MS);
    
    console.warn(
      `[playback-error-handler] FALSE POSITIVE #${consecutiveFalsePositiveCount}: Player reported error state but no video element error detected ${JSON.stringify({
        ...errorInfo,
        timeSinceLastError: timeSinceLastError !== null ? `${timeSinceLastError}ms` : 'first occurrence',
        timeSinceLastRecovery: timeSinceLastRecovery !== null ? `${timeSinceLastRecovery}ms` : 'no prior recovery',
        shouldAttemptRecovery
      })}`
    );
    
    errorOccurrenceTime = now;
    
    // Rate-limit recovery attempts to prevent excessive thrashing
    if (!shouldAttemptRecovery) {
      console.warn(`[playback-error-handler] Skipping recovery attempt (too soon after last attempt)`);
      return;
    }
    
    lastRecoveryAttemptTime = now;
    
    // Attempt recovery: try to resume playback from the current position
    // This helps recover from SABR backoff false positives
    if (currentVideo) {
      try {
        console.warn('[playback-error-handler] Attempting to recover from false positive error by resuming playback', {
          currentTime: currentVideo.currentTime.toFixed(2),
          duration: currentVideo.duration.toFixed(2),
          paused: currentVideo.paused,
          consecutiveFalsePositiveCount
        });
        
        // Check if video has sources - if not, load() was needed
        const hasSource = currentVideo.src || (currentVideo.children.length > 0 && 
          Array.from(currentVideo.children).some(child => child.tagName === 'SOURCE'));
        
        if (!hasSource) {
          console.warn('[playback-error-handler] Video element has no source, forcing reload');
          // Need to reload to restore video source
          currentVideo.load();
          // Wait for load event before attempting play
          const loadHandler = () => {
            currentVideo?.removeEventListener('loadedmetadata', loadHandler);
            setTimeout(() => {
              currentVideo?.play().catch(() => {
                console.warn('[playback-error-handler] Play after source load failed');
              });
            }, 50);
          };
          currentVideo.addEventListener('loadedmetadata', loadHandler, { once: true });
          return;
        }
        
        // Strategy 1: Try to pause and then play to reset state
        try {
          currentVideo.pause();
        } catch {
          // Ignore pause errors
        }
        
        const playPromise = currentVideo.play();
        if (playPromise !== undefined) {
          playPromise.catch((err) => {
            console.warn('[playback-error-handler] Simple play recovery failed:', err);
            
            // Strategy 2: If simple play fails, reload video with careful timing
            try {
              console.warn('[playback-error-handler] Attempting alternative recovery: reloading video element');
              const currentTime = currentVideo?.currentTime ?? 0;
              const wasPaused = currentVideo?.paused ?? true;
              
              // Reload the video element to clear internal state
              currentVideo?.load();
              
              // Restore position after a longer delay to allow load to complete
              setTimeout(() => {
                if (currentVideo) {
                  try {
                    currentVideo.currentTime = currentTime;
                    // Only try to play if it wasn't paused before the error
                    if (!wasPaused) {
                      const retryPlay = currentVideo.play();
                      if (retryPlay !== undefined) {
                        retryPlay.catch(() => {
                          console.warn('[playback-error-handler] Reload recovery play failed after delay');
                        });
                      }
                    }
                  } catch (timeErr) {
                    console.warn('[playback-error-handler] Reload recovery time restore failed:', timeErr);
                  }
                }
              }, 250);
            } catch (reloadErr) {
              console.warn('[playback-error-handler] Reload recovery attempt failed:', reloadErr);
            }
          });
        }
      } catch (err) {
        console.warn('[playback-error-handler] Recovery attempt failed:', err);
      }
    }
    return;
  }

  // There's an actual video element error - log it as a real error
  const priorFalsePositiveCount = consecutiveFalsePositiveCount;
  errorOccurrenceTime = null;
  consecutiveFalsePositiveCount = 0; // Reset false positive counter when we see a real error
  console.error(
    `[playback-error-handler] REAL ERROR: Player error state detected with video element error ${JSON.stringify({
      ...errorInfo,
      priorFalsePositives: priorFalsePositiveCount > 0 ? priorFalsePositiveCount : 'none'
    })}`
  );
}

playerManager.addEventListener('newVideo', handleNewVideo);
playerManager.addEventListener('playbackError', handlePlaybackError);
