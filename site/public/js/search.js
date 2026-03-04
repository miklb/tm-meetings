/**
 * Transcript in-page search — builds index from DOM .segment elements,
 * performs substring matching, highlights with <mark>, and scrolls to result.
 */
(function () {
  "use strict";

  let searchIndex = null;

  function initializeSearch() {
    const searchInput = document.getElementById("transcript-search");
    const searchResults = document.getElementById("search-results");

    if (!searchInput || !searchResults) return;

    // Build index from .segment elements inside .transcript-body
    searchIndex = Array.from(
      document.querySelectorAll(".transcript-body .segment")
    ).map((el, i) => {
      const turn = el.closest(".transcript-turn");
      const speaker = turn
        ? turn.querySelector(".transcript-speaker")
        : null;
      const textEl = el.querySelector(".segment-text");
      const tsEl = el.querySelector(".transcript-timestamp");
      return {
        index: i,
        element: el,
        speaker: speaker ? speaker.textContent.trim() : "",
        text: textEl ? textEl.textContent : el.textContent,
        timestamp: tsEl ? tsEl.textContent.trim() : "",
        searchText: (textEl ? textEl.textContent : el.textContent).toLowerCase(),
      };
    });

    searchInput.addEventListener("input", function (e) {
      const query = e.target.value.trim().toLowerCase();
      if (query.length < 2) {
        searchResults.classList.remove("active");
        searchResults.innerHTML = "";
        return;
      }
      performSearch(query, searchResults);
    });

    document.addEventListener("click", function (e) {
      if (!e.target.closest(".search-container")) {
        searchResults.classList.remove("active");
      }
    });

    searchInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        searchResults.classList.remove("active");
        searchInput.value = "";
        searchInput.blur();
      }
    });
  }

  function performSearch(query, container) {
    var results = searchIndex
      .filter(function (item) {
        return item.searchText.includes(query);
      })
      .slice(0, 50);

    if (results.length === 0) {
      container.innerHTML =
        '<div class="search-stats">No results found</div>';
      container.classList.add("active");
      return;
    }

    var html =
      '<div class="search-stats">Found ' +
      results.length +
      " result" +
      (results.length === 1 ? "" : "s") +
      "</div>";

    results.forEach(function (result) {
      var text = result.text;
      var words = query.split(/\s+/);
      var highlighted = text;

      words.forEach(function (word) {
        var regex = new RegExp("(" + escapeRegExp(word) + ")", "gi");
        highlighted = highlighted.replace(regex, "<mark>$1</mark>");
      });

      // Truncate around first match
      if (highlighted.length > 200) {
        var markPos = highlighted.toLowerCase().indexOf("<mark>");
        var start = Math.max(0, markPos - 50);
        var end = Math.min(highlighted.length, markPos + 150);
        highlighted =
          (start > 0 ? "&hellip;" : "") +
          highlighted.substring(start, end) +
          (end < highlighted.length ? "&hellip;" : "");
      }

      html +=
        '<button type="button" class="search-result-item" onclick="scrollToSegment(' +
        result.index +
        ')">' +
        '<span class="search-result-speaker">' +
        escapeHtml(result.speaker) +
        (result.timestamp ? " — " + escapeHtml(result.timestamp) : "") +
        "</span>" +
        '<span class="search-result-text">' +
        highlighted +
        "</span>" +
        "</button>";
    });

    container.innerHTML = html;
    container.classList.add("active");
  }

  // Exposed globally so onclick attributes work
  window.scrollToSegment = function (index) {
    var item = searchIndex[index];
    if (!item) return;

    var el = item.element;
    var searchResults = document.getElementById("search-results");
    if (searchResults) searchResults.classList.remove("active");

    // Remove previous highlights
    document.querySelectorAll(".segment.search-highlight").forEach(function (s) {
      s.classList.remove("search-highlight");
    });

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("search-highlight");

    setTimeout(function () {
      el.classList.remove("search-highlight");
    }, 2000);
  };

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function escapeHtml(s) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(s));
    return div.innerHTML;
  }

  document.addEventListener("DOMContentLoaded", initializeSearch);
})();
