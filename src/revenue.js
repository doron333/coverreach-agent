// Deal actions.
//
// Everything here is built with DOM methods and addEventListener rather than
// inline onclick strings. Generating onclick handlers inside a server-side
// template meant escaping quotes through two layers, and one bad escape
// produced a syntax error that silently disabled EVERY button on the page.
// No string-built handlers, no escaping, no repeat of that.

function closeForms() {
  var open = document.querySelectorAll(".dealform");
  for (var i = 0; i < open.length; i++) open[i].remove();
}

function field(labelText, id, placeholder, numeric) {
  var wrap = document.createElement("div");
  wrap.className = "fld";
  var label = document.createElement("label");
  label.textContent = labelText;
  var input = document.createElement("input");
  input.id = id;
  input.type = "text";
  if (numeric) input.inputMode = "decimal";
  input.placeholder = placeholder;
  wrap.appendChild(label);
  wrap.appendChild(input);
  return wrap;
}

function openForm(id, stage) {
  closeForms();
  var card = document.getElementById("lead-" + id);
  if (!card) return;

  var form = document.createElement("div");
  form.className = "dealform";
  form.appendChild(field("Annual premium", "p_" + id, "18500", true));

  if (stage === "bound") {
    form.appendChild(field("Commission rate %", "c_" + id, "12", true));
    form.appendChild(field("Carrier placed with", "w_" + id, "Progressive", false));
    form.appendChild(field("Effective date", "d_" + id, "9/11/2026", false));
    form.appendChild(field("Lines of coverage", "l_" + id, "auto liability, cargo", false));
  }

  var btns = document.createElement("div");
  btns.className = "fbtns";

  var save = document.createElement("button");
  save.className = "b bind";
  save.textContent = "Save";
  save.addEventListener("click", function () {
    post(id, stage, {
      premium: value("p_" + id),
      commissionRate: value("c_" + id),
      carrier: value("w_" + id),
      effectiveDate: value("d_" + id),
      lines: value("l_" + id),
    });
  });

  var cancel = document.createElement("button");
  cancel.className = "b lost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", closeForms);

  btns.appendChild(save);
  btns.appendChild(cancel);
  form.appendChild(btns);
  card.appendChild(form);

  var first = document.getElementById("p_" + id);
  if (first) first.focus();
}

function value(id) {
  var el = document.getElementById(id);
  return el && el.value.trim() ? el.value.trim() : null;
}

async function post(id, stage, extra) {
  var card = document.getElementById("lead-" + id);
  if (card) card.style.opacity = "0.4";
  try {
    var body = { leadId: id, stage: stage };
    if (extra) for (var k in extra) body[k] = extra[k];
    var res = await fetch("/outcome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    location.reload();
  } catch (err) {
    alert("Could not save: " + err.message);
    if (card) card.style.opacity = "1";
  }
}

function markStage(id, stage) {
  var notes = "";
  if (stage === "lost") {
    // Confirm — a stray tap here removes a live prospect from the queue, which
    // is exactly what happened within an hour of the first real reply.
    if (!confirm("Mark this lead LOST? It comes out of the action queue.")) return;
    notes = prompt("Why lost? (optional)") || "";
  }
  post(id, stage, { notes: notes });
}

function undoClose(id) {
  if (!confirm("Reopen this lead and put it back in the queue?")) return;
  post(id, "reopen", {});
}

// Wire every button from its data attributes once the page is parsed.
document.addEventListener("DOMContentLoaded", function () {
  var buttons = document.querySelectorAll("[data-lead]");
  for (var i = 0; i < buttons.length; i++) {
    (function (btn) {
      var id = btn.getAttribute("data-lead");
      var stage = btn.getAttribute("data-stage");
      btn.addEventListener("click", function () {
        if (stage === "quoted" || stage === "bound") openForm(id, stage);
        else if (stage === "reopen") undoClose(id);
        else markStage(id, stage);
      });
    })(buttons[i]);
  }
});
