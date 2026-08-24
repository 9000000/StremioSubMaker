(function () {
  'use strict';

  var byId = function (id) { return document.getElementById(id); };
  var placeholderPattern = /(YOUR_|REPLACE_|example\.com)/i;
  var state = {
    data: null,
    amount: 5,
    method: null
  };

  var elements = {
    amountPicker: byId('amountPicker'),
    amountHint: byId('amountHint'),
    customAmount: byId('customAmount'),
    customAmountWrap: byId('customAmountWrap'),
    currencySymbol: byId('currencySymbol'),
    methodPicker: byId('methodPicker'),
    anonymousChoice: byId('anonymousChoice'),
    usernameField: byId('usernameField'),
    supporterUsername: byId('supporterUsername'),
    supportCta: byId('supportCta'),
    supportCtaText: byId('supportCtaText'),
    providerNote: byId('providerNote'),
    setupNotice: byId('setupNotice'),
    afterCheckout: byId('afterCheckout'),
    recognitionMessage: byId('recognitionMessage'),
    recognitionFormLink: byId('recognitionFormLink'),
    amountToast: byId('amountToast')
  };

  function validHttpsUrl(value) {
    if (!value || placeholderPattern.test(value)) return false;
    try {
      return new URL(value).protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  function paymentMethodReady(method) {
    return Boolean(method && method.enabled && validHttpsUrl(method.url));
  }

  function formatMoney(value, currency) {
    var settings = state.data.settings || {};
    var amount = Number(value) || 0;
    try {
      return new Intl.NumberFormat(settings.locale || 'en-US', {
        style: 'currency',
        currency: currency || settings.currency || 'USD',
        maximumFractionDigits: Number.isInteger(amount) ? 0 : 2
      }).format(amount);
    } catch (_) {
      return (currency || 'USD') + ' ' + amount.toFixed(Number.isInteger(amount) ? 0 : 2);
    }
  }

  function currencySymbol(currency) {
    try {
      var parts = new Intl.NumberFormat(state.data.settings.locale || 'en-US', {
        style: 'currency',
        currency: currency,
        currencyDisplay: 'narrowSymbol'
      }).formatToParts(0);
      var currencyPart = parts.find(function (part) { return part.type === 'currency'; });
      return currencyPart ? currencyPart.value : currency;
    } catch (_) {
      return currency;
    }
  }

  function showAmountToast() {
    elements.amountToast.textContent = formatMoney(state.amount) + ' gives the timeline a little more room.';
    elements.amountToast.classList.remove('is-visible');
    void elements.amountToast.offsetWidth;
    elements.amountToast.classList.add('is-visible');
  }

  function setAmount(amount, custom) {
    var settings = state.data.settings;
    var parsed = Number(amount);
    if (!Number.isFinite(parsed)) return;
    parsed = Math.min(settings.maximumAmount || 1000, Math.max(settings.minimumAmount || 1, parsed));
    state.amount = Math.round(parsed * 100) / 100;

    Array.prototype.forEach.call(elements.amountPicker.querySelectorAll('.amount-button'), function (button) {
      var active = !custom && Number(button.dataset.amount) === state.amount;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    elements.customAmountWrap.classList.toggle('is-active', Boolean(custom));
    if (!custom) elements.customAmount.value = '';
    updateCta();
    showAmountToast();
  }

  function renderAmounts() {
    var settings = state.data.settings;
    var amounts = Array.isArray(settings.suggestedAmounts) ? settings.suggestedAmounts : [3, 5, 10, 25];
    var fragment = document.createDocumentFragment();
    elements.amountPicker.replaceChildren();
    state.amount = Number(settings.defaultAmount) || amounts[0] || 5;

    amounts.forEach(function (amount) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'amount-button';
      button.dataset.amount = amount;
      button.textContent = formatMoney(amount);
      button.setAttribute('aria-pressed', String(Number(amount) === state.amount));
      if (Number(amount) === state.amount) button.classList.add('is-active');
      button.addEventListener('click', function () { setAmount(amount, false); });
      fragment.appendChild(button);
    });
    elements.amountPicker.appendChild(fragment);

    var currency = settings.currency || 'USD';
    elements.currencySymbol.textContent = currencySymbol(currency);
    elements.amountHint.textContent = currency + ' · one-time suggestion';
    elements.customAmount.min = settings.minimumAmount || 1;
    elements.customAmount.max = settings.maximumAmount || 1000;
  }

  function methodIcon(method) {
    if (method.id === 'github') return 'GH';
    if (method.id === 'paypal') return 'P';
    if (method.id === 'crypto') return '₿';
    return String(method.shortLabel || method.label || '?').slice(0, 2).toUpperCase();
  }

  function selectMethod(method) {
    if (!paymentMethodReady(method)) return;
    state.method = method;
    Array.prototype.forEach.call(elements.methodPicker.querySelectorAll('.method-button'), function (button) {
      var active = button.dataset.method === method.id;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', String(active));
    });
    elements.afterCheckout.hidden = true;
    updateCta();
  }

  function renderMethods() {
    var methods = Array.isArray(state.data.paymentMethods) ? state.data.paymentMethods : [];
    var fragment = document.createDocumentFragment();
    var firstReady = null;
    elements.methodPicker.replaceChildren();

    methods.forEach(function (method) {
      var ready = paymentMethodReady(method);
      if (!firstReady && ready) firstReady = method;

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'method-button' + (ready ? '' : ' is-setup');
      button.dataset.method = method.id;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', 'false');
      button.setAttribute('aria-label', ready ? method.label : method.label + ' (setup required)');
      button.disabled = !ready;

      var icon = document.createElement('span');
      icon.className = 'method-icon';
      icon.textContent = methodIcon(method);

      var copy = document.createElement('span');
      copy.className = 'method-copy';
      var label = document.createElement('strong');
      label.textContent = method.shortLabel || method.label;
      var description = document.createElement('small');
      description.textContent = ready ? method.description : 'Add link to activate';
      copy.append(label, description);
      button.append(icon, copy);

      var badgeText = ready ? method.badge : 'Setup';
      if (badgeText) {
        var badge = document.createElement('span');
        badge.className = 'method-badge';
        badge.textContent = badgeText;
        button.appendChild(badge);
      }

      button.addEventListener('click', function () { selectMethod(method); });
      fragment.appendChild(button);
    });

    elements.methodPicker.appendChild(fragment);
    state.method = null;
    if (firstReady) selectMethod(firstReady);
    elements.setupNotice.hidden = Boolean(firstReady);
    updateCta();
  }

  function paymentUrl(method) {
    if (!paymentMethodReady(method)) return null;
    if (method.amountMode === 'paypal-me') {
      return method.url.replace(/\/$/, '') + '/' + state.amount + (state.data.settings.currency || 'USD');
    }
    return method.url;
  }

  function updateCta() {
    var method = state.method;
    var ready = paymentMethodReady(method);
    elements.supportCta.disabled = !ready;
    elements.supportCtaText.textContent = ready ? 'Continue with ' + method.label : 'Choose a payment method';

    if (!ready) {
      elements.providerNote.textContent = 'No payment details are collected by this page.';
    } else if (method.amountMode === 'paypal-me') {
      elements.providerNote.textContent = 'PayPal will open with ' + formatMoney(state.amount) + ' requested. Confirm before sending.';
    } else {
      elements.providerNote.textContent = formatMoney(state.amount) + ' is a suggestion. Choose and confirm the final amount with ' + method.label + '.';
    }
  }

  function recognitionFormReady() {
    return validHttpsUrl(state.data.settings.recognitionFormUrl);
  }

  function recognitionFormUrl(username) {
    var url = new URL(state.data.settings.recognitionFormUrl);
    var parameter = String(state.data.settings.recognitionUsernameParameter || '').trim();
    if (parameter) url.searchParams.set(parameter, username);
    return url.toString();
  }

  function openCheckout() {
    var url = paymentUrl(state.method);
    if (!url) return;

    var username = elements.supporterUsername.value.trim();
    if (!elements.anonymousChoice.checked && !username) {
      elements.supporterUsername.setCustomValidity('Enter the username you want shown on the Thanks page.');
      elements.supporterUsername.reportValidity();
      return;
    }
    elements.supporterUsername.setCustomValidity('');
    elements.supporterUsername.value = username;

    window.open(url, '_blank', 'noopener,noreferrer');
    elements.afterCheckout.hidden = false;

    if (elements.anonymousChoice.checked) {
      elements.recognitionMessage.textContent = 'You chose to stay anonymous, so there is nothing else to submit.';
      elements.recognitionFormLink.hidden = true;
    } else if (recognitionFormReady()) {
      elements.recognitionMessage.textContent = 'Submit “' + username + '” through the short form to add it to the Thanks page.';
      elements.recognitionFormLink.href = recognitionFormUrl(username);
      elements.recognitionFormLink.hidden = false;
    } else {
      elements.recognitionMessage.textContent = 'Public recognition is selected, but the maintainer still needs to configure the recognition form.';
      elements.recognitionFormLink.hidden = true;
    }
  }

  function supporterInitials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (part) { return part.charAt(0); }).join('').toUpperCase() || '?';
  }

  function renderSupporters() {
    var supporters = (Array.isArray(state.data.supporters) ? state.data.supporters : []).filter(function (supporter) {
      return supporter && supporter.public !== false && supporter.name;
    });
    var grid = byId('supporterGrid');
    var empty = byId('supportersEmpty');
    byId('anonymousCount').textContent = String(Math.max(0, Number(state.data.settings.anonymousSupportCount) || 0));
    grid.replaceChildren();
    empty.hidden = supporters.length > 0;

    supporters.forEach(function (supporter) {
      var card = document.createElement('article');
      card.className = 'supporter-card';
      var avatar = document.createElement('span');
      avatar.className = 'supporter-avatar';
      avatar.textContent = supporterInitials(supporter.name);
      var copy = document.createElement('div');
      var name = document.createElement('strong');
      name.textContent = supporter.name;
      var detail = document.createElement('small');
      detail.textContent = supporter.note || (supporter.since ? 'Supporting since ' + supporter.since : 'SubMaker supporter');
      copy.append(name, detail);
      card.append(avatar, copy);
      grid.appendChild(card);
    });
  }

  function configureProjectLinks() {
    var project = state.data.project || {};
    if (validHttpsUrl(project.repositoryUrl)) {
      byId('footerRepositoryLink').href = project.repositoryUrl;
    }
    if (validHttpsUrl(project.hostingSponsorUrl)) {
      byId('hostingSponsorLink').href = project.hostingSponsorUrl;
      byId('hostingSponsorLink').textContent = project.hostingSponsorName || 'the hosting sponsor';
    }
  }

  function configureTabs() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
    var panels = Array.prototype.slice.call(document.querySelectorAll('[role="tabpanel"]'));

    function activate(tab) {
      tabs.forEach(function (candidate) {
        var active = candidate === tab;
        candidate.classList.toggle('is-active', active);
        candidate.setAttribute('aria-selected', String(active));
        candidate.tabIndex = active ? 0 : -1;
      });
      panels.forEach(function (panel) {
        var active = panel.dataset.panel === tab.dataset.tab;
        panel.hidden = !active;
        panel.classList.toggle('is-active', active);
      });
    }

    tabs.forEach(function (tab, index) {
      tab.addEventListener('click', function () { activate(tab); });
      tab.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        var direction = event.key === 'ArrowRight' ? 1 : -1;
        var next = tabs[(index + direction + tabs.length) % tabs.length];
        activate(next);
        next.focus();
      });
    });
  }

  function configureTheme() {
    var themes = ['light', 'dark', 'blackhole'];
    var toggle = byId('themeToggle');
    toggle.addEventListener('click', function () {
      var current = document.documentElement.getAttribute('data-theme') || 'dark';
      var next = themes[(themes.indexOf(current) + 1) % themes.length];
      document.documentElement.setAttribute('data-theme', next);
      document.querySelector('meta[name="theme-color"]').content = next === 'light' ? '#edf6fa' : (next === 'blackhole' ? '#000000' : '#080d20');
      try { localStorage.setItem('submaker-support-theme', next); } catch (_) {}
    });
  }

  function configureEvents() {
    elements.customAmount.addEventListener('input', function () {
      if (elements.customAmount.value === '') {
        elements.customAmountWrap.classList.remove('is-active');
        return;
      }
      setAmount(elements.customAmount.value, true);
    });
    elements.supportCta.addEventListener('click', openCheckout);
  }

  function configureRecognitionChoice() {
    elements.anonymousChoice.addEventListener('change', function () {
      elements.afterCheckout.hidden = true;
      elements.usernameField.hidden = elements.anonymousChoice.checked;
      elements.supporterUsername.required = !elements.anonymousChoice.checked;
      elements.supporterUsername.setCustomValidity('');
      if (!elements.anonymousChoice.checked) elements.supporterUsername.focus();
    });
    elements.supporterUsername.addEventListener('input', function () {
      elements.supporterUsername.setCustomValidity('');
      elements.afterCheckout.hidden = true;
    });
  }

  function init(data) {
    state.data = data;
    state.data.settings = state.data.settings || {};
    configureProjectLinks();
    renderAmounts();
    renderMethods();
    renderSupporters();
    configureEvents();
  }

  configureTabs();
  configureTheme();
  configureRecognitionChoice();

  fetch('./support-data.json', { cache: 'no-store' })
    .then(function (response) {
      if (!response.ok) throw new Error('Could not load support-data.json');
      return response.json();
    })
    .then(init)
    .catch(function (error) {
      elements.setupNotice.hidden = false;
      elements.setupNotice.querySelector('strong').textContent = 'Data could not load';
      elements.setupNotice.querySelector('span').textContent = error.message + '. Preview the page through a local web server, not a file:// URL.';
      elements.supportCta.disabled = true;
      elements.supportCtaText.textContent = 'Support page needs configuration';
    });
}());
