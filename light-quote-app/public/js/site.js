// Lumiquote marketing site: the before/after slider, the guided live demo and the two calculators.
(function () {
  "use strict";

  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var $$ = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };
  var money = function (n) { return "$" + Math.round(n).toLocaleString("en-US"); };
  var round25 = function (n) { return Math.round(n / 25) * 25; };
  var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- hero: drag to compare the photo with the lit-up preview ---------- */
  var compare = $("#ba");
  var compareRange = $("#ba-range");
  if (compare && compareRange) {
    var setCompare = function () { compare.style.setProperty("--pos", compareRange.value + "%"); };
    compareRange.addEventListener("input", setCompare);
    setCompare();
  }

  /* ---------- live demo: the homeowner's phone and the installer's dashboard, in four steps ---------- */
  var tour = $("#tour");
  if (tour) {
    // The pictures are real output: one daytime photo run through Lumiquote's preview engine for each option.
    var IMAGES = "/img/house/";
    // Example numbers only. Each installer sets their own rates inside the product.
    var PER_FOOT = 6;
    var ESTIMATE_FEET = 110;
    var MEASURED_FEET = 118;
    var TREES_EXAMPLE = 360;
    var MINIMUM = 350;
    var SERVICE_LABEL = { roofline: "Roofline", trees: "Trees and shrubs", full: "Full house" };
    var SERVICE_ALT = { roofline: "along the roofline", trees: "on the tree and shrubs", full: "on the roofline, tree and shrubs" };
    var COLOR_ALT = { warm: "warm white", cool: "bright white", multi: "multicolour" };
    var STEP_TEXT = {
      1: "A homeowner taps your link, picks what they want lit and adds a photo. No app. About two minutes.",
      2: "They get their own home lit up in three colours with a price range. The request lands on your dashboard.",
      3: "Trace the roofline from above and the quote fills itself in at your rates. One tap texts it.",
      4: "They accept on their phone and pick an install date. It shows as booked on your side.",
    };
    var NEXT_LABEL = { 1: "Next: see it lit up", 2: "Next: switch to the installer", 3: "Next: text the quote" };

    var dayLabel = function (offset) {
      var d = new Date();
      d.setDate(d.getDate() + offset);
      return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    };
    var DATES = [dayLabel(9), dayLabel(12)];
    var state = { step: 1, service: "full", color: "warm", date: DATES[0], booked: false };

    var estimate = function () {
      var total = (state.service !== "trees" ? ESTIMATE_FEET * PER_FOOT : 0) + (state.service !== "roofline" ? TREES_EXAMPLE : 0);
      var low = Math.max(MINIMUM, round25(total * 0.85));
      var high = Math.max(low, round25(total * 1.15));
      return low === high ? "From " + money(low) : money(low) + " – " + money(high);
    };
    var quote = function () {
      var lines = [];
      if (state.service !== "trees") lines.push({ label: "Roofline lighting", detail: MEASURED_FEET + " ft × " + money(PER_FOOT), amount: MEASURED_FEET * PER_FOOT });
      if (state.service !== "roofline") lines.push({ label: "Tree and shrubs", detail: "1 tree, 5 shrubs", amount: TREES_EXAMPLE });
      return { lines: lines, total: lines.reduce(function (sum, l) { return sum + l.amount; }, 0) };
    };

    var photo = $("#demo-photo");
    var wanted = "";
    var showPhoto = function (file, alt) {
      if (!photo) return;
      var url = IMAGES + file;
      photo.alt = alt;
      if (wanted === url) return;
      wanted = url;
      // Load off-screen first so the picture swaps cleanly instead of flashing empty.
      var loader = new Image();
      loader.onload = function () { if (wanted === url) photo.src = url; };
      loader.src = url;
    };
    var warmed = false;
    var warmUp = function () {
      if (warmed) return;
      warmed = true;
      ["roofline", "trees", "full"].forEach(function (service) {
        ["warm", "cool", "multi"].forEach(function (color) { new Image().src = IMAGES + service + "-" + color + ".jpg"; });
      });
    };

    var fillLines = function () {
      var q = quote();
      $$(".quote-lines", tour).forEach(function (list) {
        list.textContent = "";
        q.lines.forEach(function (line) {
          var li = document.createElement("li");
          var left = document.createElement("span");
          left.textContent = line.label;
          var detail = document.createElement("small");
          detail.textContent = line.detail;
          left.appendChild(detail);
          var right = document.createElement("b");
          right.textContent = money(line.amount);
          li.appendChild(left);
          li.appendChild(right);
          list.appendChild(li);
        });
      });
      $$(".quote-total", tour).forEach(function (node) { node.textContent = money(q.total); });
    };

    var traceTimer = 0;
    var runTrace = function () {
      var path = $(".trace", tour);
      var feet = $("#feet");
      cancelAnimationFrame(traceTimer);
      if (!path || !feet) return;
      if (reducedMotion) { feet.textContent = MEASURED_FEET; return; }
      path.classList.remove("run");
      void path.getBoundingClientRect(); // restart the stroke animation
      path.classList.add("run");
      var started = performance.now();
      var tick = function (now) {
        var t = Math.min(1, (now - started) / 1600);
        feet.textContent = Math.round(MEASURED_FEET * (1 - Math.pow(1 - t, 2)));
        if (t < 1) traceTimer = requestAnimationFrame(tick);
      };
      traceTimer = requestAnimationFrame(tick);
    };

    var render = function () {
      tour.dataset.step = state.step;
      $$(".pane", tour).forEach(function (pane) { pane.hidden = Number(pane.dataset.pane) !== state.step; });
      $$(".tour-steps button", tour).forEach(function (button) {
        if (Number(button.dataset.go) === state.step) button.setAttribute("aria-current", "step");
        else button.removeAttribute("aria-current");
      });
      var now = $("#tour-now");
      if (now) now.textContent = STEP_TEXT[state.step];
      var next = $("#tour-next");
      if (next) next.textContent = state.step < 4 ? NEXT_LABEL[state.step] : state.booked ? "Start again" : "Accept and book for them";

      $$('.opts[data-group="service"] button', tour).forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.value === state.service)); });
      $$('.opts[data-group="color"] button', tour).forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.value === state.color)); });

      var before = state.color === "before";
      showPhoto(
        before ? "before.jpg" : state.service + "-" + state.color + ".jpg",
        before ? "The home in daylight, before lights" : "The same home at dusk with " + COLOR_ALT[state.color] + " lights " + SERVICE_ALT[state.service]
      );
      var tag = $("#demo-tag");
      if (tag) tag.textContent = before ? "Their photo" : "Preview of their home";
      $$(".demo-thumb", tour).forEach(function (img) { img.src = IMAGES + state.service + "-warm.jpg"; });

      var price = $("#demo-price");
      if (price) price.textContent = estimate();
      var wants = $(".lead-wants", tour);
      if (wants) wants.textContent = SERVICE_LABEL[state.service] + " · est. " + estimate();
      fillLines();

      var dates = $('.opts[data-group="date"]', tour);
      if (dates) {
        dates.textContent = "";
        DATES.forEach(function (label) {
          var button = document.createElement("button");
          button.type = "button";
          button.dataset.value = label;
          button.textContent = label;
          button.setAttribute("aria-pressed", String(label === state.date));
          dates.appendChild(button);
        });
      }
      $("#quote-open").hidden = state.booked;
      $("#quote-booked").hidden = !state.booked;
      $$(".booked-date", tour).forEach(function (node) { node.textContent = state.date; });
      var status = $("#lead-status");
      status.textContent = state.booked ? "Booked" : "Quote sent";
      status.className = "badge " + (state.booked ? "badge-booked" : "badge-sent");
      $("#lead-date").textContent = state.booked ? "install " + state.date : "waiting for them to accept";
      $("#dash-note").textContent = state.booked
        ? "Booked without a site visit. The job, the date and the price are on your dashboard."
        : "Texted from your phone. Now it is their move: tap Accept and book on their phone.";
    };

    var playTimers = [];
    var stopPlay = function () {
      playTimers.forEach(clearTimeout);
      playTimers = [];
      var play = $("#tour-play");
      if (play) play.textContent = "Play it for me";
    };
    var go = function (step) {
      if (step === 1) { state.booked = false; state.date = DATES[0]; state.color = "warm"; }
      state.step = Math.max(1, Math.min(4, step));
      warmUp();
      render();
      if (state.step === 3) runTrace();
    };
    var accept = function () { state.booked = true; render(); };

    tour.addEventListener("click", function (event) {
      var target = event.target;
      if (target.closest("#tour-play")) {
        if (playTimers.length) return stopPlay();
        go(1);
        $("#tour-play").textContent = "Stop";
        var at = 0;
        [[2600, function () { go(2); }], [3200, function () { go(3); }], [3600, function () { go(4); }], [2400, function () { accept(); stopPlay(); }]].forEach(function (pair) {
          at += pair[0];
          playTimers.push(setTimeout(pair[1], at));
        });
        return;
      }
      if (target.closest("#tour-next")) {
        stopPlay();
        if (state.step < 4) return go(state.step + 1);
        return state.booked ? go(1) : accept();
      }
      if (target.closest("#accept")) { stopPlay(); return accept(); }
      var jump = target.closest("[data-go]");
      if (jump) { stopPlay(); return go(Number(jump.dataset.go)); }
      var option = target.closest(".opts[data-group] button[data-value]");
      if (option) {
        stopPlay();
        state[option.closest(".opts").dataset.group] = option.dataset.value;
        warmUp();
        render();
      }
    });

    /* white-label controls */
    var setBrand = function (color) {
      var phone = $("#phone");
      if (!phone || !/^#[0-9a-f]{6}$/i.test(color)) return;
      var rgb = [1, 3, 5].map(function (i) { return parseInt(color.slice(i, i + 2), 16) / 255; });
      var lin = rgb.map(function (c) { return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
      var luminance = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
      phone.style.setProperty("--brand", color);
      phone.style.setProperty("--on-brand", luminance > 0.45 ? "#14171f" : "#ffffff");
      // A very light brand colour would vanish as text on the white bar, so the phone link falls back to dark ink.
      $("#demo-tel").style.color = luminance > 0.6 ? "#14171f" : color;
    };
    $$(".swatches button").forEach(function (button) {
      button.addEventListener("click", function () {
        $$(".swatches button").forEach(function (b) { b.setAttribute("aria-pressed", String(b === button)); });
        setBrand(button.dataset.color);
        var picker = $("#demo-color");
        if (picker) picker.value = button.dataset.color;
      });
    });
    var picker = $("#demo-color");
    if (picker) {
      picker.addEventListener("input", function () {
        $$(".swatches button").forEach(function (b) { b.setAttribute("aria-pressed", "false"); });
        setBrand(picker.value);
      });
    }
    var nameInput = $("#demo-name");
    if (nameInput) {
      nameInput.addEventListener("input", function () {
        var name = nameInput.value.trim() || "Your Company";
        $$(".co-name", tour).forEach(function (node) { node.textContent = name; });
      });
    }

    render();
  }

  /* ---------- sticky call button: only once the hero's own button has scrolled away ---------- */
  var callBar = $(".call-bar");
  var heroCta = $("#hero-cta");
  var closer = $(".closer");
  if (callBar && heroCta && "IntersectionObserver" in window) {
    var visible = new Set();
    var watcher = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      });
      callBar.classList.toggle("show", visible.size === 0);
    });
    watcher.observe(heroCta);
    if (closer) watcher.observe(closer);
  } else if (callBar) {
    callBar.classList.add("show");
  }

  /* ---------- calculators ---------- */
  function bind(ids, render) {
    ids.forEach(function (id) {
      var input = $("#" + id);
      if (input) input.addEventListener("input", render);
    });
    render();
  }

  bind(["t-quotes", "t-mins"], function () {
    var quotes = Number($("#t-quotes").value);
    var minutes = Number($("#t-mins").value);
    var hours = Math.round((quotes * minutes * 10) / 60);
    var days = Math.round(hours / 8);
    $("#t-quotes-out").textContent = quotes;
    $("#t-mins-out").textContent = minutes;
    $("#t-hours").textContent = hours.toLocaleString("en-US") + " hours";
    $("#t-days").textContent = days >= 1
      ? "That is about " + days + " full working day" + (days === 1 ? "" : "s") + " you could spend installing."
      : "Even a few hours back is another install.";
  });

  bind(["r-fee", "r-years"], function () {
    var fee = Number($("#r-fee").value);
    var years = Number($("#r-years").value);
    $("#r-fee-out").textContent = money(fee);
    $("#r-years-out").textContent = years + (years === 1 ? " year" : " years");
    $("#r-total").textContent = money(fee * 12 * years);
  });
})();
