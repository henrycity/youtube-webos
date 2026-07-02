import { getPlayerManager } from './player_api';
import type { EventMapOf, PlayerManager } from './player_api';

const playerManager = await getPlayerManager();

type EventMap = EventMapOf<PlayerManager>;

let currentVideo: HTMLVideoElement | null = null;

function handleVideoError(this: HTMLVideoElement) {
  const err = this.error;
  console.error(
    `[playback-error-handler] Video element error ${JSON.stringify(err ? { code: err.code, message: err.message } : null)}`
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
  }
}

function handlePlaybackError(this: PlayerManager, event: EventMap['playbackError']) {
  const videoData = this.player.getVideoData();
  const playerState = this.player.getPlayerStateObject();
  const videoErr = currentVideo?.error;

  const errorInfo = {
    videoId: videoData.video_id,
    title: videoData.title,
    playerState,
    videoError: videoErr ? { code: videoErr.code, message: videoErr.message } : null
  };

  // Log the event object from the callback for debugging
  console.error(
    `[playback-error-handler] Playback error event ${JSON.stringify({
      type: event.type,
      detail: event.detail,
      currentTarget: event.currentTarget?.constructor?.name ?? null
    })}`
  );

  // If there's no actual video element error (videoError is null) but the player
  // thinks there's an error, this is likely a false positive caused by SABR backoff.
  // Attempt recovery by resuming playback without reloading the video.
  if (!videoErr) {
    console.warn(
      `[playback-error-handler] Player reported error state but no video element error detected ${JSON.stringify(errorInfo)}`
    );
    
    // Attempt recovery: try to resume playback from the current position
    // This helps recover from SABR backoff false positives
    if (currentVideo) {
      try {
        console.warn('[playback-error-handler] Attempting to recover from false positive error by resuming playback');
        
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
  console.error(
    `[playback-error-handler] Player error state detected with video element error ${JSON.stringify(errorInfo)}`
  );
}

playerManager.addEventListener('newVideo', handleNewVideo);
playerManager.addEventListener('playbackError', handlePlaybackError);
