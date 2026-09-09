/**
 * /notifications/ — subscribe, request a management link, manage keywords,
 * unsubscribe. Talks to the Pages Functions under /api/.
 *
 * Was inline in notifications.njk. Server text only ever lands in the page
 * through textContent; the local-dev links are built as elements.
 */
(function () {
  "use strict";

  const statusBanner = document.getElementById('status-banner');

  const subscribeCard = document.getElementById('subscribe-card');
  const subscribeForm = document.getElementById('subscribe-form');
  const subEmail = document.getElementById('sub-email');
  const tagContainer = document.getElementById('tag-container');
  const subKeywordsInput = document.getElementById('sub-keywords');
  const btnSubscribe = document.getElementById('btn-subscribe');

  const requestCard = document.getElementById('request-card');
  const requestForm = document.getElementById('request-form');
  const reqEmail = document.getElementById('req-email');
  const btnRequest = document.getElementById('btn-request');

  const manageCard = document.getElementById('manage-card');
  const manageForm = document.getElementById('manage-form');
  const manageTagContainer = document.getElementById('manage-tag-container');
  const manageKeywordsInput = document.getElementById('manage-keywords');
  const manageEmailDisplay = document.getElementById('manage-email-display');
  const limitHelp = document.getElementById('limit-help');
  const btnSave = document.getElementById('btn-save');
  const btnUnsubscribe = document.getElementById('btn-unsubscribe');
  const manageUserBadge = document.getElementById('manage-user-badge');

  const showManageRequestBtn = document.getElementById('show-manage-request');
  const backToSubscribeBtn = document.getElementById('back-to-subscribe');
  const logoutBtn = document.getElementById('logout-btn');

  if (!subscribeForm || !requestForm || !manageForm) return;

  // App State
  let subscribeTags = [];
  let manageTags = [];
  let currentToken = '';       // short-lived session token for keyword management
  let unsubscribeToken = '';   // permanent token for one-click unsubscribe
  let activeEmail = '';
  let keywordLimit = 15;

  const STATUS_MESSAGES = {
    verified: ['success', "Success! Your email address has been verified. You will now receive meeting alerts."],
    already_verified: ['success', "This subscription has already been verified."],
    unsubscribed: ['success', "You have unsubscribed successfully. All keywords and subscription details have been deleted."],
    verify_failed: ['error', "Email verification failed. The link may have expired or is invalid. Please request a new subscription."],
    verify_expired: ['error', "That verification link is more than 3 days old. Enter your email under Manage keywords and we'll send a fresh one."],
    unsubscribe_failed: ['error', "Failed to unsubscribe. The token may be invalid or expired."],
  };

  function init() {
    initTagInput(tagContainer, subKeywordsInput, subscribeTags);
    initTagInput(manageTagContainer, manageKeywordsInput, manageTags);

    const params = new URLSearchParams(window.location.search);
    const status = params.get('status');
    const email = params.get('email');
    const token = params.get('token');

    if (status) handleQueryStatus(status);
    if (email && token) loadManagement(email, token);

    // Clean the query out of the URL history
    if (window.history.replaceState) {
      const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
      window.history.replaceState({ path: cleanUrl }, '', cleanUrl);
    }
  }

  function handleQueryStatus(status) {
    const entry = STATUS_MESSAGES[status];
    if (!entry) return;
    showBanner(entry[1], entry[0]);
  }

  /**
   * Read a JSON body, or explain what came back instead. A Cloudflare error
   * page or a timeout is HTML, and res.json() on it used to surface a raw
   * TypeError to the reader.
   */
  async function readJson(res) {
    const type = res.headers.get('content-type') || '';
    if (!type.includes('application/json')) {
      throw new Error(res.ok
        ? "The alerts service replied in an unexpected format. Please try again."
        : `The alerts service is unavailable right now (${res.status}). Please try again in a few minutes.`);
    }
    try {
      return await res.json();
    } catch (_) {
      throw new Error("The alerts service replied in an unexpected format. Please try again.");
    }
  }

  async function loadManagement(email, token) {
    showLoading(true);
    try {
      const res = await fetch('/api/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, token })
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || 'Failed to load subscription details.');

      activeEmail = data.email;
      currentToken = token;
      unsubscribeToken = data.unsubscribeToken || '';
      keywordLimit = data.keywordLimit || 15;

      manageEmailDisplay.textContent = activeEmail;
      manageUserBadge.textContent = 'Member';

      manageTags.length = 0;
      manageTags.push(...(data.keywords || []));
      renderTags(manageTagContainer, manageKeywordsInput, manageTags);
      updateLimitHelp();

      // Keep a success notice (e.g. "verified") when arriving from a link;
      // clear stale errors.
      switchPanel('manage');
      if (statusBanner.classList.contains('error')) showBanner('');
    } catch (err) {
      // Land on the request-a-link form so "request a new one" is right there
      showBanner(err.message, 'error');
      switchPanel('request');
    } finally {
      showLoading(false);
    }
  }

  // --- Tag input ---
  function initTagInput(container, input, tagsArray) {
    input.placeholder = tagsArray.length > 0 ? "Add tag..." : "e.g. rezoning, stormwater";

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addTagFromInput(container, input, tagsArray);
      } else if (e.key === 'Backspace' && input.value === '') {
        tagsArray.pop();
        renderTags(container, input, tagsArray);
      }
    });

    input.addEventListener('blur', () => {
      addTagFromInput(container, input, tagsArray);
    });
  }

  function addTagFromInput(container, input, tagsArray) {
    const val = input.value.trim().replace(/,/g, '');
    if (val.length >= 2 && val.length <= 50) {
      if (!tagsArray.includes(val.toLowerCase())) {
        tagsArray.push(val.toLowerCase());
        renderTags(container, input, tagsArray);
      }
      input.value = '';
    } else {
      input.value = val; // leave it there if it fails constraints
    }
  }

  function renderTags(container, input, tagsArray) {
    container.querySelectorAll('.tag').forEach(t => t.remove());

    tagsArray.forEach((tagText, index) => {
      const tagEl = document.createElement('span');
      tagEl.className = 'tag';
      tagEl.appendChild(document.createTextNode(tagText));

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'tag-remove';
      removeBtn.setAttribute('aria-label', `Remove ${tagText}`);
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        tagsArray.splice(index, 1);
        renderTags(container, input, tagsArray);
        input.focus();
      });
      tagEl.appendChild(removeBtn);

      container.insertBefore(tagEl, input);
    });

    updateLimitHelp();
  }

  function updateLimitHelp() {
    limitHelp.textContent = `Active: ${manageTags.length} / ${keywordLimit} keywords max.`;
    if (manageTags.length >= keywordLimit) {
      manageKeywordsInput.disabled = true;
      manageKeywordsInput.placeholder = "Limit reached";
    } else {
      manageKeywordsInput.disabled = false;
      manageKeywordsInput.placeholder = "Add a keyword...";
    }
  }

  function turnstileToken(form) {
    const field = form.querySelector('[name="cf-turnstile-response"]');
    return field ? field.value : '';
  }

  function resetTurnstile(id) {
    const el = document.getElementById(id);
    if (window.turnstile && el) window.turnstile.reset(el);
  }

  // --- API calls ---

  subscribeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    addTagFromInput(tagContainer, subKeywordsInput, subscribeTags);

    const email = subEmail.value.trim();
    if (!email) {
      showBanner("Please enter a valid email address.", "error");
      subEmail.focus();
      return;
    }
    if (subscribeTags.length === 0) {
      showBanner("Please add at least one keyword.", "error");
      subKeywordsInput.focus();
      return;
    }

    setBtnLoading(btnSubscribe, true, "Subscribing...");
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, keywords: subscribeTags, turnstile_token: turnstileToken(subscribeForm) })
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "Subscription request failed.");

      showBanner(data.message, 'success',
        data.devVerifyUrl ? { href: data.devVerifyUrl, text: "[Local Dev Mode] Click here to verify subscription →" } : null);
      subscribeForm.reset();
      subscribeTags.length = 0;
      renderTags(tagContainer, subKeywordsInput, subscribeTags);
    } catch (err) {
      showBanner(err.message, 'error');
    } finally {
      resetTurnstile('sub-turnstile');
      setBtnLoading(btnSubscribe, false, "Subscribe");
    }
  });

  requestForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = reqEmail.value.trim();
    if (!email) {
      showBanner("Please enter your email address.", "error");
      reqEmail.focus();
      return;
    }

    setBtnLoading(btnRequest, true, "Sending...");
    try {
      const res = await fetch('/api/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, turnstile_token: turnstileToken(requestForm) })
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "Request failed.");

      let link = null;
      if (data.devManageUrl) link = { href: data.devManageUrl, text: "[Local Dev Mode] Click here to open your dashboard →" };
      else if (data.devVerifyUrl) link = { href: data.devVerifyUrl, text: "[Local Dev Mode] Click here to verify subscription →" };
      showBanner(data.message, 'success', link);
      requestForm.reset();
      switchPanel('subscribe');
    } catch (err) {
      showBanner(err.message, 'error');
    } finally {
      resetTurnstile('req-turnstile');
      setBtnLoading(btnRequest, false, "Send Management Link");
    }
  });

  manageForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    addTagFromInput(manageTagContainer, manageKeywordsInput, manageTags);

    if (manageTags.length === 0) {
      showBanner("You must enter at least one keyword. If you want to stop all notifications, click Unsubscribe below.", "error");
      manageKeywordsInput.focus();
      return;
    }

    setBtnLoading(btnSave, true, "Saving...");
    try {
      const res = await fetch('/api/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: activeEmail, token: currentToken, keywords: manageTags })
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "Save failed.");

      showBanner(data.message, 'success');
      manageTags.length = 0;
      manageTags.push(...(data.keywords || []));
      renderTags(manageTagContainer, manageKeywordsInput, manageTags);
    } catch (err) {
      showBanner(err.message, 'error');
    } finally {
      setBtnLoading(btnSave, false, "Save Changes");
    }
  });

  // Deletion only happens on POST, so email-scanner GETs are harmless
  btnUnsubscribe.addEventListener('click', async () => {
    if (!confirm("Are you sure you want to unsubscribe? This will permanently delete your notification settings.")) {
      return;
    }
    try {
      const res = await fetch(`/api/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`, { method: 'POST' });
      if (!res.ok && res.status !== 303) {
        throw new Error("Failed to unsubscribe. Please try again or use the link in a recent email.");
      }
      switchPanel('subscribe');
      handleQueryStatus('unsubscribed');
    } catch (err) {
      showBanner(err.message, 'error');
    }
  });

  // --- UI helpers ---
  function switchPanel(panelName) {
    subscribeCard.classList.add('hidden');
    requestCard.classList.add('hidden');
    manageCard.classList.add('hidden');
    const card = { subscribe: subscribeCard, request: requestCard, manage: manageCard }[panelName];
    if (card) {
      card.classList.remove('hidden');
      const heading = card.querySelector('h1, h2');
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    }
  }

  /** Show a message (text only) with an optional link built as an element. */
  function showBanner(msg, type, link) {
    if (!msg) {
      statusBanner.classList.add('hidden');
      statusBanner.replaceChildren();
      return;
    }
    statusBanner.classList.remove('hidden', 'success', 'error');
    statusBanner.classList.add(type);
    statusBanner.replaceChildren(document.createTextNode(msg));
    if (link) {
      statusBanner.appendChild(document.createElement('br'));
      const a = document.createElement('a');
      a.href = link.href;
      a.textContent = link.text;
      statusBanner.appendChild(a);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showLoading(active) {
    document.querySelectorAll('.notifications-card').forEach(p => {
      p.style.opacity = active ? '0.5' : '1';
      p.style.pointerEvents = active ? 'none' : 'auto';
      p.setAttribute('aria-busy', active ? 'true' : 'false');
    });
  }

  function setBtnLoading(btn, isLoading, text) {
    btn.disabled = isLoading;
    btn.textContent = text;
  }

  showManageRequestBtn.addEventListener('click', () => { switchPanel('request'); showBanner(''); });
  backToSubscribeBtn.addEventListener('click', () => { switchPanel('subscribe'); showBanner(''); });
  logoutBtn.addEventListener('click', () => {
    currentToken = '';
    unsubscribeToken = '';
    activeEmail = '';
    switchPanel('subscribe');
    showBanner('');
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
