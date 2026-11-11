// Lumiquote marketing site: the lit-up house, the "try it" demo and the two calculators.
(function () {
  "use strict";

  var SVG = "http://www.w3.org/2000/svg";
  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var $$ = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };

  /* ---------- the house illustration ---------- */
  function line(from, to, count) {
    var points = [];
    for (var i = 0; i <= count; i++) {
      points.push([from[0] + ((to[0] - from[0]) * i) / count, from[1] + ((to[1] - from[1]) * i) / count]);
    }
    return points;
  }
  var ROOF = line([60, 120], [160, 50], 8).concat(line([160, 50], [260, 120], 8).slice(1));
  var TREES = [[278, 134], [296, 128], [302, 146], [284, 150], [292, 162], [290, 140], [26, 182], [36, 176], [46, 183]];
  var PALETTES = {
    warm: ["#ffd27a"],
    cool: ["#dff1ff"],
    multi: ["#ff5a5f", "#4ade80", "#60a5fa", "#ffd27a"],
  };

  function el(name, attrs) {
    var node = document.createElementNS(SVG, name);
    Object.keys(attrs).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    return node;
  }

  function drawHouse(svg) {
    if (!svg) return null;
    svg.textContent = "";
    var stars = [[22, 22], [70, 40], [118, 16], [196, 26], [238, 12], [282, 44], [306, 84], [40, 78]];
    stars.forEach(function (s) { svg.appendChild(el("circle", { cx: s[0], cy: s[1], r: 1.1, fill: "#dfe8ff", opacity: 0.7 })); });
    svg.appendChild(el("path", { d: "M0 192h320", stroke: "#2b3a66", "stroke-width": 2 }));
    svg.appendChild(el("ellipse", { cx: 36, cy: 184, rx: 20, ry: 12, fill: "#12203f", stroke: "#3a4b80", "stroke-width": 1.5 }));
    svg.appendChild(el("path", { d: "M290 192v-30", stroke: "#3a4b80", "stroke-width": 4, "stroke-linecap": "round" }));
    svg.appendChild(el("circle", { cx: 290, cy: 142, r: 25, fill: "#12203f", stroke: "#3a4b80", "stroke-width": 1.5 }));
    svg.appendChild(el("rect", { x: 78, y: 120, width: 164, height: 72, fill: "#17244d", stroke: "#3a4b80", "stroke-width": 1.5 }));
    svg.appendChild(el("path", { d: "M60 120 160 50l100 70", fill: "#101a3a", stroke: "#3a4b80", "stroke-width": 1.5, "stroke-linejoin": "round" }));
    svg.appendChild(el("rect", { x: 146, y: 150, width: 28, height: 42, rx: 2, fill: "#0d1631", stroke: "#3a4b80", "stroke-width": 1.5 }));
    svg.appendChild(el("rect", { x: 96, y: 136, width: 32, height: 26, rx: 2, fill: "#ffcf7a", opacity: 0.85 }));
    svg.appendChild(el("rect", { x: 192, y: 136, width: 32, height: 26, rx: 2, fill: "#ffcf7a", opacity: 0.85 }));

    var groups = { roof: el("g", {}), trees: el("g", {}) };
    [["roof", ROOF], ["trees", TREES]].forEach(function (pair) {
      pair[1].forEach(function (p) {
        var bulb = el("g", { class: "bulb", transform: "translate(" + p[0] + " " + p[1] + ")" });
        bulb.appendChild(el("circle", { class: "halo", r: 7, fill: "currentColor" }));
        bulb.appendChild(el("circle", { r: 2.800, fill: "currentColor" }));
        groups[pair[0]].appendChild(bulb);
      });
      svg.appendChild(groups[pair[0]]);
    });
    return groups;
  }

  function light(groups, service, color) {
    if (!groups) return;
    var palette = PALETTES[color] || PALETTES.warm;
    var on = { roof: service !== "trees", trees: service !== "roofline" };
    ["roof", "trees"].forEach(function (name) {
      $$(".bulb", groups[name]).forEach(function (bulb, i) {
        bulb.style.color = on[name] ? palette[i % palette.length] : "#2c3a66";
        bulb.style.opacity = on[name] ? "1" : "0.5";
        bulb.classList.toggle("bulb-on", on[name]);
      });
    });
  }

  light(drawHouse($("#hero-scene")), "full", "warm");

  /* ---------- "try it" demo ---------- */
  var demo = { service: "roofline", size: "medium", color: "warm" };
  var demoGroups = drawHouse($("#demo-scene"));
  // Example rates only. Each installer sets their own inside the product.
  var FEET = { small: 70, medium: 110, large: 160, xl: 220 };
  var PER_FOOT = 6;
  var TREES_EXAMPLE = 360;
  var MINIMUM = 350;
  var SIZE_LABEL = { small: "Small home", medium: "Medium home", large: "Large home", xl: "Extra large home" };
  var SERVICE_LABEL = { roofline: "Roofline", trees: "Trees and shrubs", full: "Full house" };
  var money = function (n) { return "$" + Math.round(n).toLocaleString("en-US"); };
  var round25 = function (n) { return Math.round(n / 25) * 25; };

  function renderDemo() {
    light(demoGroups, demo.service, demo.color);
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
      renderDemo();
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
  renderDemo();

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
