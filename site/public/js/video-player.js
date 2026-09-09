/**
 * YouTube IFrame API controller — initializes players, handles part tabs
 * (click + arrow keys), and seeks the in-page player from transcript
 * timestamps and chapter links.
 *
 * Every timestamp and chapter is a real link to the video on YouTube; this
 * script only intercepts a click when the player for that part is ready.
 * If the IFrame API is blocked or still loading, the link just works.
 */
(function () {
  "use strict";

  var players = [];
  var ready = [];
  var currentVideoIndex = 0;
  var tabs = [];

  /** Called by the YouTube IFrame API once loaded. */
  window.onYouTubeIframeAPIReady = function () {
    document.querySelectorAll(".video-player").forEach(function (el, index) {
      var videoId = el.dataset.videoId;
      if (!videoId) return;
      players[index] = new YT.Player("player-" + index, {
        videoId: videoId,
        playerVars: { rel: 0, modestbranding: 1, origin: window.location.origin },
        events: {
          onReady: function () { ready[index] = true; },
          onError: function (event) { handlePlayerError(event, index); },
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
    var container = document.getElementById("player-" + playerIndex);
    var videoEl = document.getElementById("video-" + playerIndex);
    if (!container || !videoEl) return;
    ready[playerIndex] = false;

    var box = document.createElement("div");
    box.className = "video-error";
    var p = document.createElement("p");
    p.textContent = messages[event.data] || "Playback error";
    var a = document.createElement("a");
    a.href = "https://www.youtube.com/watch?v=" + encodeURIComponent(videoEl.dataset.videoId || "");
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Watch on YouTube ↗";
    box.appendChild(p);
    box.appendChild(a);
    container.replaceChildren(box);
  }

  /** Switch the active part: tab state, panel, chapters; pause the others. */
  function switchVideo(index, focusTab) {
    currentVideoIndex = index;

    tabs.forEach(function (tab, i) {
      var isActive = i === index;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
      tab.tabIndex = isActive ? 0 : -1;
      if (isActive && focusTab) tab.focus();
    });

    document.querySelectorAll(".video-player").forEach(function (p, i) {
      p.classList.toggle("active", i === index);
    });
    document.querySelectorAll(".chapters-list").forEach(function (cl, i) {
      cl.classList.toggle("active", i === index);
    });

    players.forEach(function (player, i) {
      if (i !== index && player && player.pauseVideo) {
        try { player.pauseVideo(); } catch (_) {}
      }
    });
  }

  function readyPlayer(part) {
    var i = part - 1;
    return ready[i] && players[i] && players[i].seekTo ? players[i] : null;
  }

  function seek(seconds, part) {
    var i = part - 1;
    if (i !== currentVideoIndex) switchVideo(i, false);
    var player = players[i];
    player.seekTo(seconds, true);
    player.playVideo();
  }

  // Delegated: timestamp and chapter links seek in-page when the player is
  // ready; otherwise the href (youtu.be/…?t=) navigates.
  document.addEventListener("click", function (e) {
    var link = e.target.closest("a.transcript-timestamp, a.chapter-item");
    if (!link) return;
    var holder = link.hasAttribute("data-seconds") ? link : link.closest("[data-seconds]");
    if (!holder) return;
    var seconds = parseFloat(holder.dataset.seconds);
    var part = parseInt(holder.dataset.videoPart, 10) || 1;
    if (isNaN(seconds) || !readyPlayer(part)) return;
    e.preventDefault();
    seek(seconds, part);
  });

  /** Tabs: click to switch; Left/Right/Up/Down/Home/End move and activate. */
  function bindTabs() {
    tabs = Array.prototype.slice.call(document.querySelectorAll(".video-tab"));
    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () { switchVideo(i, false); });
      tab.addEventListener("keydown", function (e) {
        var next = null;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % tabs.length;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = tabs.length - 1;
        if (next === null) return;
        e.preventDefault();
        switchVideo(next, true);
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindTabs);
  } else {
    bindTabs();
  }

  window.switchVideo = switchVideo;
})();
