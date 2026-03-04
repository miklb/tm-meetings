/**
 * YouTube IFrame API controller — initializes players, handles tab
 * switching, seekToTimestamp(), and seekToChapter() for the meeting
 * two-panel layout.
 *
 * Loaded after the YouTube IFrame API script tag in base.njk.
 */
(function () {
  "use strict";

  var players = [];
  var currentVideoIndex = 0;

  /**
   * Called automatically by the YouTube IFrame API once loaded.
   */
  window.onYouTubeIframeAPIReady = function () {
    var containers = document.querySelectorAll(".video-player");
    containers.forEach(function (el, index) {
      var videoId = el.dataset.videoId;
      if (!videoId) return;

      players[index] = new YT.Player("player-" + index, {
        videoId: videoId,
        playerVars: {
          rel: 0,
          modestbranding: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: function () {},
          onError: function (event) {
            handlePlayerError(event, index);
          },
        },
      });
    });
  };

  function handlePlayerError(event, playerIndex) {
    var messages = {
      2: "Invalid video ID",
      5: "HTML5 player error",
      100: "Video not found or private",
      101: "Embedding not allowed by video owner",
      150: "Embedding not allowed by video owner",
    };
    var msg = messages[event.data] || "Playback error";
    var container = document.getElementById("player-" + playerIndex);
    var videoEl = document.getElementById("video-" + playerIndex);
    if (container && videoEl) {
      var vid = videoEl.dataset.videoId;
      container.innerHTML =
        '<div class="video-error">' +
        "<p>" + msg + "</p>" +
        '<a href="https://www.youtube.com/watch?v=' + vid + '" ' +
        'target="_blank" rel="noopener noreferrer">Watch on YouTube &nearr;</a>' +
        "</div>";
    }
  }

  /**
   * Switch active video tab and player panel.
   */
  window.switchVideo = function (index) {
    currentVideoIndex = index;

    document.querySelectorAll(".video-tab").forEach(function (tab, i) {
      var isActive = i === index;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
    });

    document.querySelectorAll(".video-player").forEach(function (p, i) {
      p.classList.toggle("active", i === index);
    });

    document.querySelectorAll(".chapters-list").forEach(function (cl, i) {
      cl.classList.toggle("active", i === index);
    });

    // Pause other players
    players.forEach(function (player, i) {
      if (i !== index && player && player.pauseVideo) {
        try { player.pauseVideo(); } catch (_) {}
      }
    });
  };

  /**
   * Seek to a specific second in a specific video part.
   * Called by transcript timestamp onclick and chapter buttons.
   */
  window.seekToTimestamp = function (seconds, videoPart) {
    var videoIndex = videoPart - 1;

    if (videoIndex !== currentVideoIndex) {
      window.switchVideo(videoIndex);
    }

    // Small delay for tab switch / player readiness
    setTimeout(function () {
      var player = players[videoIndex];
      if (player && player.seekTo) {
        player.seekTo(seconds, true);
        player.playVideo();
      }
    }, 300);
  };

  /**
   * Chapter click handler — delegates to seekToTimestamp.
   */
  window.seekToChapter = function (seconds, videoPart) {
    window.seekToTimestamp(seconds, videoPart);
  };
})();
