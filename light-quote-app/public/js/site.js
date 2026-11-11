// Lumiquote marketing site: the before/after slider, the "try it" demo and the two calculators.
(function () {
  "use strict";

  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var $$ = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };

  /* ---------- hero: drag to compare the photo with the lit-up preview ---------- */
  var compare = $("#ba");
  var compareRange = $("#ba-range");
  if (compare && compareRange) {
    var setCompare = function () { compare.style.setProperty("--pos", compareRange.value + "%"); };
    compareRange.addEventListener("input", setCompare);
    setCompare();
  }

  /* ---------- "try it" demo ---------- */
  // The images are real output: one daytime photo run through Lumiquote's preview engine for each option.
  var IMAGES = "/img/house/";
  var demo = { service: "roofline", size: "medium", color: "warm" };
  // Example rates only. Each installer sets their own inside the product.
  var FEET = { small: 70, medium: 110, large: 160, xl: 220 };
  var PER_FOOT = 6;
  var TREES_EXAMPLE = 360;
  var MINIMUM = 350;
  var SIZE_LABEL = { small: "Small home", medium: "Medium home", large: "Large home", xl: "Extra large home" };
  var SERVICE_LABEL = { roofline: "Roofline", trees: "Trees and shrubs", full: "Full house" };
  var SERVICE_ALT = { roofline: "along the roofline", trees: "on the tree and shrubs", full: "on the roofline, tree and shrubs" };
  var COLOR_ALT = { warm: "warm white", cool: "bright white", multi: "multicolour" };
  var money = function (n) { return "$" + Math.round(n).toLocaleString("en-US"); };
  var round25 = function (n) { return Math.round(n / 25) * 25; };

  var photo = $("#demo-photo");
  var wanted = "";
  function showPhoto(file, alt) {
    if (!photo) return;
    var url = IMAGES + file;
    wanted = url;
    photo.alt = alt;
    // Load off-screen first so the picture swaps cleanly instead of flashing empty.
    var loader = new Image();
    loader.onload = function () { if (wanted === url) photo.src = url; };
    loader.src = url;
  }

  var warmed = false;
  function warmUp() {
    if (warmed) return;
    warmed = true;
    ["roofline", "trees", "full"].forEach(function (service) {
      ["warm", "cool", "multi"].forEach(function (color) { new Image().src = IMAGES + service + "-" + color + ".jpg"; });
    });
    new Image().src = IMAGES + "before.jpg";
  }

  function renderDemo(swapPhoto) {
    var before = demo.color === "before";
    if (swapPhoto) {
      showPhoto(
        before ? "before.jpg" : demo.service + "-" + demo.color + ".jpg",
        before ? "The home in daylight, before lights" : "The same home at dusk with " + COLOR_ALT[demo.color] + " lights " + SERVICE_ALT[demo.service]
      );
    }
    var tag = $("#demo-tag");
    if (tag) tag.textContent = before ? "Their photo" : "Preview of their home";
    var total = (demo.service !== "trees" ? FEET[demo.size] * PER_FOOT : 0) + (demo.service !== "roofline" ? TREES_EXAMPLE : 0);
    var low = Math.max(MINIMUM, round25(total * 0.85));
    var high = Math.max(low, round25(total * 1.15));
    var price = $("#demo-price");
    if (price) price.textContent = low === high ? "From " + money(low) : money(low) + " – " + money(high);
    var what = $("#demo-what");
    if (what) what.textContent = SERVICE_LABEL[demo.service] + (demo.service === "trees" ? "" : " · " + SIZE_LABEL[demo.size]);
  }

  $$(".seg[data-group]").forEach(function (group) {
    group.addEventListener("click", function (event) {
      var button = event.target.closest("button[data-value]");
      if (!button) return;
      demo[group.dataset.group] = button.dataset.value;
      $$("button", group).forEach(function (b) { b.setAttribute("aria-pressed", String(b === button)); });
      warmUp();
      renderDemo(true);
    });
  });

  function setBrand(color) {
    var phone = $("#phone");
    if (!phone || !/^#[0-9a-f]{6}$/i.test(color)) return;
    var rgb = [1, 3, 5].map(function (i) { return parseInt(color.slice(i, i + 2), 16) / 255; });
    var lin = rgb.map(function (c) { return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
    var luminance = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    phone.style.setProperty("--brand", color);
    phone.style.setProperty("--on-brand", luminance > 0.45 ? "#14171f" : "#ffffff");
    // A very light brand colour would vanish as text on the white bar, so the phone link falls back to dark ink.
    $("#demo-tel").style.color = luminance > 0.6 ? "#14171f" : color;
  }

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
      $("#demo-company").textContent = nameInput.value.trim() || "Your Company";
    });
  }
  // The first picture is already in the page, so the opening render only fills in the price.
  renderDemo(false);

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
