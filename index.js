// index.js -- Cloud Run FUNCTIONS (Node 22 / ESM)
// Entry point: helloHttp
// GET  /health
// POST /prompt       → gera prompt completo
// POST /refine-prompt → refina com feedback do usuário
//
// v9 — CLOUD MASTER V2: Motor Multiagente + Super Reviewer + Feedback Engine

///////////////////////
// Utils
///////////////////////
function asciiSafe(s = "", maxLen = 1200) {
  let t = String(s || "");
  try { t = t.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""); } catch {}
  t = t
    .replace(/[""„‟]/g, '"')
    .replace(/[''‛‚]/g, "'")
    .replace(/[‐-‒–—―]/g, "-")
    .replace(/[`´]/g, "");
  t = t.replace(/[^\x20-\x7E]/g, "").trim().replace(/\s+/g, " ");
  return t.length > maxLen ? t.slice(0, maxLen).trim() : t;
}

function normalize(s = "") {
  return asciiSafe(String(s || ""), 500)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim();
}

function hasAny(text, arr) { return arr.some((k) => text.includes(k)); }

function joinText(...parts) {
  return parts.filter(Boolean).join(" ").trim();
}

function uniq(arr) { return Array.from(new Set(arr.filter(Boolean))); }

function sendJson(res, status, obj) {
  res.status(status).set("Content-Type", "application/json").send(JSON.stringify(obj));
}

function setCors(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return true; }
  return false;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

///////////////////////
// CAMADA 1 — Product Parser
///////////////////////
function parseProductContext({ product_name = "", vision_description = "" } = {}) {
  const raw = joinText(product_name, vision_description);
  const text = normalize(raw);

  const ctx = {
    raw_text: raw,
    normalized_text: text,
    target_user: "adult",
    gender_presentation: "unknown",
    climate_hint: "unknown",
    usage_context: "unknown",
    has_human_block: false,
    wants_handheld: false,
    product_family: "generic",
    product_subtype: "generic",
  };

  if (hasAny(text, ["infantil","kids","kid","baby","bebe","toddler","juvenil"])) {
    ctx.target_user = "child";
  } else if (hasAny(text, ["plus size","plus-size","plussize","curvy","acima do peso","gordinha","gordinho"])) {
    ctx.target_user = "adult";
    ctx.usage_context = "plus_size_fashion";
  }

  if (hasAny(text, ["feminina","feminino","female","woman","mulher","noiva","bride","moça","moca"])) {
    ctx.gender_presentation = "female";
  } else if (hasAny(text, ["masculina","masculino","male","man","homem","noivo","groom"])) {
    ctx.gender_presentation = "male";
  } else if (hasAny(text, ["unissex","unisex"])) {
    ctx.gender_presentation = "unisex";
  }

  if (hasAny(text, [
    "sem modelo","sem humano","without model","no model","no human",
    "so o produto","so a sandalia","sem pe de modelo","produto sozinho","sem pessoa","sem gente",
  ])) {
    ctx.has_human_block = true;
  }

  if (hasAny(text, ["segurando na mao","held in hand","holding","segurar na mao","na mao","hold"])) {
    ctx.wants_handheld = true;
  }

  if (hasAny(text, ["inverno","winter","cold","frio","neve"])) {
    ctx.climate_hint = "cold";
  } else if (hasAny(text, ["summer","verao","quente","beach","praia"])) {
    ctx.climate_hint = "warm";
  }

  if (hasAny(text, ["futebol","football","soccer","esportivo","sport","treino","corrida","running","academia","gym"])) {
    ctx.usage_context = "sports";
  } else if (hasAny(text, ["casa","home","living room","sala","cozinha","kitchen"])) {
    ctx.usage_context = "home";
  } else if (hasAny(text, ["luxo","luxury","premium","elegante","elegant","casamento","wedding","festa","party","formatura"])) {
    ctx.usage_context = "premium";
  } else if (hasAny(text, ["barbearia","barber","barbershop","salao","salon"])) {
    ctx.usage_context = "barber";
  }

  return ctx;
}

///////////////////////
// CAMADA 2 — Router
///////////////////////
function classifyUsageMode({ product_name = "", vision_description = "" } = {}) {
  const text = normalize(joinText(product_name, vision_description));

  if (hasAny(text, [
    "camisa","camiseta","vestido","calca","jaqueta","conjunto","roupa","moletom",
    "uniforme","hoodie","tracksuit","brinco","colar","pulseira","anel","oculos",
    "tenis","sapato","sandalia","bota","chuteira","bolsa","mochila","relogio",
    "luva","meias","colete","blazer","blusa","regata","cropped","saia","legging",
    "pochete","crossbody","bone","chapeu","tiara","headband","munhequeira",
    "alianca","bermuda","sunga","biquini","maio","short","bermuda",
  ])) return "wearable_use";

  if (hasAny(text, [
    "buque","bouquet","flor","flores","ramo","perfume","cosmetic","cosmetico",
    "caneta","pincel","escova","tesoura","faca","utensilio pequeno",
    "celular","smartphone","tablet","camera","controle",
  ])) return "handheld_use";

  if (hasAny(text, [
    "vassoura","rodo","esfregao","panela","frigideira","ferramenta",
    "utensilio","limpeza","cleaning","broom","mop","tool",
    "martelo","chave de fenda","furadeira","aspirador","maquina de lavar",
  ])) return "active_usage";

  if (hasAny(text, [
    "tapete","escada","cadeira","sofa","quadro","luminaria","mesa","rack",
    "armario","espelho","ladder","carpet","furniture","prateleira","organizador",
    "cama","colchao","edredom","almofada",
  ])) return "placed_environment";

  return "surface_display_use";
}

function resolveUsageAgent(mode, parsed) {
  const text = parsed.normalized_text;

  if (mode === "wearable_use") {
    if (parsed.target_user === "child") return "fashion_kids_wearable_agent";
    if (hasAny(text, ["brinco","argola","earring","piercing"])) return "jewelry_ear_agent";
    if (hasAny(text, ["colar","corrente","gargantilha","choker","necklace"])) return "jewelry_neck_agent";
    if (hasAny(text, ["pulseira","anel","alianca","relogio","smartwatch","bracelet","ring","watch","munhequeira"])) return "jewelry_hand_agent";
    if (hasAny(text, ["tenis","sapato","sandalia","bota","chuteira","chinelo","sapatilha","shoe","sneaker","boot"])) return "footwear_agent";
    if (hasAny(text, ["bolsa","mochila","pochete","crossbody","bag","backpack"])) return "bag_agent";
    return "fashion_wearable_agent";
  }

  if (mode === "handheld_use") return "handheld_use_agent";
  if (mode === "placed_environment") return "placed_environment_agent";
  if (mode === "active_usage") return "active_usage_agent";
  return "surface_display_use_agent";
}

///////////////////////
// CAMADA 3 — Scene Planner
///////////////////////
function autoScene(mode, parsed) {
  const text = parsed.normalized_text;

  if (mode === "wearable_use") {
    if (parsed.target_user === "child" && parsed.usage_context === "sports") {
      if (parsed.climate_hint === "cold")
        return "professional kids sportswear campaign in a cool outdoor football-related setting, such as a winter football field or cold urban sports street";
      return "professional kids sportswear campaign in an outdoor football or sports lifestyle setting";
    }
    if (parsed.usage_context === "premium")
      return "elegant premium fashion setting with sophisticated lighting, luxury background";
    if (hasAny(text, ["brinco","argola","colar","corrente","pulseira","anel","alianca"]))
      return "premium close-up commercial setting with refined background and elegant natural lighting";
    if (hasAny(text, ["tenis","sapato","sandalia","bota","chuteira"])) {
      if (parsed.usage_context === "sports") return "outdoor sports environment, dynamic action scene with realistic ground contact";
      return "commercial lifestyle usage scene with realistic walking or standing context";
    }
    if (hasAny(text, ["bolsa","mochila","pochete"]))
      return "commercial lifestyle fashion scene in a refined urban or indoor premium environment";
    if (parsed.usage_context === "sports") return "outdoor sports lifestyle environment, natural light, active context";
    if (parsed.climate_hint === "warm") return "bright outdoor lifestyle scene, warm natural light, summer environment";
    if (parsed.climate_hint === "cold") return "cozy indoor or cold outdoor lifestyle scene, natural winter tones";
    return "professional lifestyle environment with natural commercial lighting";
  }

  if (mode === "handheld_use") {
    if (hasAny(text, ["buque","bouquet","flor","flores"])) {
      if (parsed.usage_context === "premium") return "elegant romantic wedding or event commercial scene";
      return "elegant romantic commercial scene with natural elegant lighting";
    }
    if (hasAny(text, ["perfume","fragrance","cologne"]))
      return "premium vanity or elegant surface scene with refined lighting, luxury feel";
    if (hasAny(text, ["celular","smartphone","tablet","camera"]))
      return "modern lifestyle setting, person using device naturally in a clean environment";
    return "natural hand-held usage scene in a refined commercial context";
  }

  if (mode === "placed_environment") {
    if (hasAny(text, ["tapete","carpet","rug"]))
      return "beautiful well-composed living room or bedroom environment with realistic decor styling";
    if (hasAny(text, ["escada","ladder"]))
      return "realistic architectural or utility environment where the ladder naturally belongs, such as a garage, backyard, or home maintenance setting";
    if (hasAny(text, ["sofa","cadeira","poltrona"]))
      return "well-designed modern living room with natural lighting and tasteful decor";
    if (hasAny(text, ["quadro","espelho"]))
      return "clean interior wall in a modern home with natural lighting";
    if (hasAny(text, ["cama","colchao","edredom","almofada"]))
      return "cozy well-designed bedroom with soft natural lighting and tasteful decor";
    return "well-designed realistic environment where the product naturally belongs";
  }

  if (mode === "active_usage") {
    if (hasAny(text, ["vassoura","rodo","esfregao","broom","mop"]))
      return "clean domestic interior scene showing realistic home cleaning usage";
    if (hasAny(text, ["panela","frigideira"]))
      return "realistic kitchen scene showing natural usage in a cooking environment";
    if (hasAny(text, ["martelo","chave de fenda","furadeira","tool"]))
      return "realistic workshop or home maintenance scene showing the tool being used correctly";
    return "realistic action scene showing the product being used correctly in its natural environment";
  }

  // surface_display_use
  if (hasAny(text, ["perfume","fragrance","cologne","eau de"]))
    return "premium vanity or elegant bathroom counter scene with refined lighting";
  if (hasAny(text, ["suplemento","whey","vitamina","remedio","medicine","capsula"]))
    return "clean premium surface with subtle professional lighting, health lifestyle context";
  if (parsed.usage_context === "barber")
    return "barbershop counter or professional styling station with atmospheric lighting";
  return "clean realistic commercial surface context with proper lighting";
}

///////////////////////
// CAMADA 4 — Identity Lock
///////////////////////
function buildIdentityBlock() {
  return [
    "The product must remain visually identical to the reference image.",
    "Do not change color, shape, material, texture, proportions, logo, or design.",
    "Do not redesign, simplify, reinterpret, or replace the product.",
    "All unique details, textures, shapes, and design elements must match the reference exactly.",
  ].join(" ");
}

///////////////////////
// Physical Anchor
///////////////////////
function resolvePhysicalAnchor(mode, agent, parsed) {
  const text = parsed.normalized_text;

  if (mode === "wearable_use") {
    if (agent === "jewelry_ear_agent") return "firmly attached to the earlobe, correct position and scale";
    if (agent === "jewelry_neck_agent") return "worn naturally around the neck, correct drape and scale";
    if (agent === "jewelry_hand_agent") {
      if (hasAny(text, ["pulseira","relogio","watch","bracelet","munhequeira"])) return "worn naturally on the wrist";
      return "worn naturally on the finger, correct size and position";
    }
    if (agent === "footwear_agent") return "worn naturally on the feet, correct orientation and realistic ground contact";
    if (agent === "bag_agent") {
      if (hasAny(text, ["mochila","backpack"])) return "worn naturally on the back or carried in a realistic usage pose";
      if (hasAny(text, ["pochete","crossbody","tiracolo"])) return "worn crossbody in a natural lifestyle pose";
      return "carried naturally on the shoulder or in a realistic fashion pose";
    }
    if (agent === "fashion_kids_wearable_agent") return "worn correctly on a child's body with realistic proportions and natural pose";
    return "worn naturally on the body with correct position and realistic proportions";
  }

  if (mode === "handheld_use") {
    if (hasAny(text, ["buque","bouquet","flor","flores"]))
      return "held naturally with one or both hands at chest level in a realistic elegant pose";
    if (hasAny(text, ["celular","smartphone","tablet"]))
      return "held naturally in one hand with realistic grip and correct scale";
    return "held naturally in hand with realistic contact and correct scale";
  }

  if (mode === "placed_environment") {
    if (hasAny(text, ["tapete","carpet","rug"])) return "placed flat on the floor with realistic contact and correct scale";
    if (hasAny(text, ["escada","ladder"])) return "positioned naturally in the environment with realistic ground contact and correct orientation";
    if (hasAny(text, ["quadro","espelho"])) return "mounted correctly on the wall at realistic height";
    if (hasAny(text, ["sofa","cadeira"])) return "positioned naturally in the room with realistic floor contact";
    return "integrated naturally into the environment with realistic contact, correct scale, and correct orientation";
  }

  if (mode === "active_usage") {
    return "being used naturally in a realistic functional position with proper contact and correct interaction";
  }

  return "placed naturally on a realistic surface with correct perspective, grounding shadow, and contact";
}

///////////////////////
// Shot Type
///////////////////////
function inferShotType(agent, mode) {
  if (agent === "jewelry_ear_agent") return "tight close-up portrait, ear clearly visible";
  if (agent === "jewelry_neck_agent") return "close-up or mid close-up portrait";
  if (agent === "jewelry_hand_agent") return "close-up of hand or wrist, clean background";
  if (agent === "fashion_kids_wearable_agent") return "full-body professional campaign shot";
  if (agent === "fashion_wearable_agent") return "full-body or mid-body commercial lifestyle shot";
  if (agent === "footwear_agent") return "commercial footwear shot, knee-to-ground or full lifestyle pose";
  if (agent === "bag_agent") return "commercial lifestyle fashion shot, product prominently visible";
  if (mode === "placed_environment") return "realistic room or environment view with product as focal point";
  if (mode === "surface_display_use") return "clean contextual close-up commercial shot";
  if (mode === "active_usage") return "realistic action shot showing natural product usage";
  return "realistic commercial lifestyle shot";
}

///////////////////////
// Negatives
///////////////////////
function baseNegativeTerms() {
  return [
    "floating", "duplicate product", "multiple instances",
    "packaging", "barcode", "label", "product card",
    "altered design", "wrong color", "wrong shape", "wrong material",
    "wrong proportions", "wrong position",
    "blurry", "low quality", "CGI", "cartoon", "watermark", "text",
    "mannequin on product", "display stand",
  ];
}

function agentNegativeTerms(agent) {
  const map = {
    jewelry_ear_agent: ["hand","fingers","holding","touching","earring not on ear","floating earring","wrong ear placement"],
    jewelry_neck_agent: ["holding necklace","floating necklace","necklace not worn","wrong necklace position"],
    jewelry_hand_agent: ["deformed fingers","bad hands","wrong finger placement","wrong wrist placement","extra fingers"],
    footwear_agent: ["floating shoes","shoes not worn","wrong foot position","deformed feet","wrong scale shoes"],
    bag_agent: ["floating bag","wrong straps","extra pockets not in original","altered hardware","bag not worn"],
    fashion_kids_wearable_agent: ["adult model","adult proportions","mannequin","store background","retail scene","wrong age"],
    fashion_wearable_agent: ["mannequin","flat clothing","floating clothing","clothing not worn","wrong body proportions"],
    handheld_use_agent: ["floating object","wrong hand pose","deformed hands","object not held","extra hands"],
    placed_environment_agent: ["floating object","wrong scale","unrealistic placement","bad perspective","no ground contact"],
    active_usage_agent: ["incorrect usage","no contact","product displayed instead of used","unrealistic action"],
    surface_display_use_agent: ["floating object","no surface contact","bad perspective","product in mid-air"],
  };
  return map[agent] || map["surface_display_use_agent"];
}

///////////////////////
// CAMADA 5 — Prompt Builder
///////////////////////
function buildPrompt({ product_name, scene_request, vision_description, mode, agent, parsed, extra_positive_notes = [], extra_negative_terms = [] }) {
  const scene = (scene_request || "").trim() || autoScene(mode, parsed);
  const physicalAnchor = resolvePhysicalAnchor(mode, agent, parsed);
  const shotType = inferShotType(agent, mode);

  let humanBlock;
  if (parsed.has_human_block) {
    humanBlock = "Do not show any person, model, or human body. Product only.";
  } else if (mode === "wearable_use") {
    const genderStr = parsed.gender_presentation === "female" ? "female"
      : parsed.gender_presentation === "male" ? "male" : "";
    const sizeStr = parsed.usage_context === "plus_size_fashion" ? "plus-size " : "";
    const ageStr = parsed.target_user === "child" ? "child" : `${genderStr} ${sizeStr}person`.trim();
    humanBlock = `A ${ageStr} is present to show the product worn naturally with correct body proportions.`;
  } else if (mode === "handheld_use") {
    humanBlock = "A person may be present only as needed to hold the product naturally in realistic use.";
  } else if (mode === "active_usage") {
    humanBlock = "A person may be present only as needed to demonstrate realistic active usage.";
  } else {
    humanBlock = "No unnecessary person should appear in the scene. Product is the sole focus.";
  }

  const qualityBlock = [
    "High-quality realistic commercial photo.",
    "Realistic lighting, natural shadows, correct scale, authentic textures, and natural integration.",
    "The product appears only once and only in its intended usage form.",
  ].join(" ");

  const pos = [
    qualityBlock,
    `Product: ${vision_description || product_name || "product"}.`,
    buildIdentityBlock(),
    `Physical placement: the product is ${physicalAnchor}.`,
    `Scene: ${scene}.`,
    `Framing: ${shotType}.`,
    humanBlock,
    ...extra_positive_notes,
  ].filter(Boolean).join(" ");

  const neg = uniq([
    ...baseNegativeTerms(),
    ...agentNegativeTerms(agent),
    ...extra_negative_terms,
  ]).join(", ");

  return {
    positive_prompt: asciiSafe(pos),
    negative_prompt: asciiSafe(neg),
    meta: {
      mode, agent,
      target_user: parsed.target_user,
      usage_context: parsed.usage_context,
      climate_hint: parsed.climate_hint,
      scene_source: (scene_request || "").trim() ? "user" : "auto",
      shot_type: shotType,
      physical_anchor: physicalAnchor,
    },
  };
}

///////////////////////
// CAMADA 6 — Feedback Engine
///////////////////////
function interpretFeedback(user_feedback = "") {
  const text = normalize(user_feedback);
  const result = {
    issue_types: [],
    allowed_changes: [],
    locked_elements: ["product_identity"],
    extra_positive_notes: [],
    extra_negative_terms: [],
  };

  if (!text) return result;

  if (hasAny(text, ["fundo ruim","cenario ruim","cenario feio","ambiente ruim","mais profissional","background bad","scene bad","fundo feio","fundo errado"])) {
    result.issue_types.push("scene_quality");
    result.allowed_changes.push("scene","lighting","style");
    result.extra_positive_notes.push("Use a more refined, professional, and commercially appealing environment.");
    result.extra_negative_terms.push("bad background","ugly background","poor scene quality");
  }

  if (hasAny(text, ["muito grande","muito pequeno","escala errada","wrong scale","oversized","too small","proporcao errada","nao parece real"])) {
    result.issue_types.push("scale");
    result.allowed_changes.push("scale","framing");
    result.extra_positive_notes.push("Ensure correct realistic scale relative to the environment or human body.");
    result.extra_negative_terms.push("wrong scale","oversized","too small","unrealistic proportions");
  }

  if (hasAny(text, ["nao ficou igual","mudou a cor","mudou o logo","produto alterado","not same product","wrong product","different product","mudou o produto","cor errada","design errado","nao e o mesmo"])) {
    result.issue_types.push("identity_error");
    result.allowed_changes.push("identity_strength");
    result.extra_positive_notes.push("Exact visual match to the reference product. No redesign, no variation, no reinterpretation.");
    result.extra_negative_terms.push("different product","altered design","wrong logo","wrong color","reinterpreted product");
  }

  if (hasAny(text, ["flutuando","torto","posicao errada","wrong position","floating","posicao incorreta","mal posicionado"])) {
    result.issue_types.push("position");
    result.allowed_changes.push("position","interaction");
    result.extra_positive_notes.push("Reinforce correct physical placement, realistic contact with surface or body, natural shadow.");
    result.extra_negative_terms.push("floating","wrong position","incorrect placement","no ground contact");
  }

  if (hasAny(text, ["parece ia","muito fake","artificial","cgi","not realistic","parece computador","parece falso","nao parece foto","muito digital"])) {
    result.issue_types.push("realism");
    result.allowed_changes.push("lighting","style","textures");
    result.extra_positive_notes.push("Increase realism: authentic textures, natural cinematic lighting, real commercial photographic quality.");
    result.extra_negative_terms.push("cgi look","fake lighting","artificial textures","synthetic feel","digital art style");
  }

  if (hasAny(text, ["pessoa errada","modelo errado","pessoa nao era pra aparecer","sem pessoa","sem modelo","so o produto"])) {
    result.issue_types.push("unwanted_human");
    result.allowed_changes.push("human_presence");
    result.extra_positive_notes.push("Do not show any person, model, or human body. Product only.");
    result.extra_negative_terms.push("person","model","human body","hands","feet in frame");
  }

  result.issue_types = uniq(result.issue_types);
  result.allowed_changes = uniq(result.allowed_changes);
  result.extra_positive_notes = uniq(result.extra_positive_notes);
  result.extra_negative_terms = uniq(result.extra_negative_terms);
  return result;
}

///////////////////////
// CAMADA 7 — Super Reviewer
///////////////////////
function reviewPromptAndImage({ user_feedback = "" } = {}) {
  const feedback = interpretFeedback(user_feedback);
  return {
    approved: feedback.issue_types.length === 0,
    issues: feedback.issue_types,
    allowed_changes: feedback.allowed_changes,
    locked: ["product_identity","product_color","product_shape","product_design"],
    fixes: {
      positive_additions: feedback.extra_positive_notes,
      negative_additions: feedback.extra_negative_terms,
    },
  };
}

///////////////////////
// Entry — geração completa
///////////////////////
function generatePrompt({ product_name, scene_request, vision_description, user_feedback } = {}) {
  const parsed = parseProductContext({ product_name, vision_description });
  const mode = classifyUsageMode({ product_name, vision_description });
  const agent = resolveUsageAgent(mode, parsed);

  let extra_positive_notes = [];
  let extra_negative_terms = [];
  let review;

  if (user_feedback && user_feedback.trim()) {
    const fb = interpretFeedback(user_feedback);
    extra_positive_notes = fb.extra_positive_notes;
    extra_negative_terms = fb.extra_negative_terms;
    review = {
      approved: fb.issue_types.length === 0,
      issues: fb.issue_types,
      allowed_changes: fb.allowed_changes,
      locked: ["product_identity"],
      fixes: { positive_additions: fb.extra_positive_notes, negative_additions: fb.extra_negative_terms },
    };
  }

  const result = buildPrompt({
    product_name: product_name || vision_description || "product",
    scene_request,
    vision_description,
    mode, agent, parsed,
    extra_positive_notes,
    extra_negative_terms,
  });

  return { ...result, ...(review ? { review } : {}) };
}

///////////////////////
// HTTP Handler
///////////////////////
export function helloHttp(req, res) {
  if (setCors(req, res)) return;

  const url = req.url || "/";

  // Health check
  if (req.method === "GET" && (url === "/health" || url === "/" || url === "")) {
    return sendJson(res, 200, { ok: true, service: "promptuso-v9-cloud-master-v2", version: "9.0.0" });
  }

  // POST /prompt
  if (req.method === "POST" && (url === "/prompt" || url === "/" || url === "")) {
    readJsonBody(req).then(body => {
      const product_name =
        body?.produto ?? body?.produto_frase ?? body?.product ?? body?.product_name ?? body?.name ?? "";
      const scene_request =
        body?.cenario ?? body?.scenario ?? body?.scene ?? body?.scene_request ?? body?.contexto ?? "";
      const vision_description =
        body?.vision_desc ?? body?.vision_description ?? body?.vision ?? "";
      const user_feedback =
        body?.user_feedback ?? body?.feedback ?? "";

      if (!product_name) {
        return sendJson(res, 400, { ok: false, error: "Missing product_name / produto / product" });
      }

      const result = generatePrompt({ product_name, scene_request, vision_description, user_feedback });

      sendJson(res, 200, {
        ok: true,
        positive: result.positive_prompt,
        negative: result.negative_prompt,
        meta: result.meta,
        ...(result.review ? { review: result.review } : {}),
        source: "cloud_run_v9_multiagent",
      });
    }).catch(err => {
      sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
    });
    return;
  }

  // POST /refine-prompt
  if (req.method === "POST" && url === "/refine-prompt") {
    readJsonBody(req).then(body => {
      const product_name =
        body?.product_name ?? body?.produto ?? body?.product ?? "";
      const scene_request =
        body?.scene_request ?? body?.cenario ?? body?.scene ?? "";
      const vision_description =
        body?.vision_description ?? body?.vision_desc ?? body?.vision ?? "";
      const user_feedback =
        body?.user_feedback ?? body?.feedback ?? "";

      if (!product_name) {
        return sendJson(res, 400, { ok: false, error: "Missing product_name" });
      }

      const feedbackAnalysis = interpretFeedback(user_feedback);
      const result = generatePrompt({ product_name, scene_request, vision_description, user_feedback });

      sendJson(res, 200, {
        ok: true,
        positive: result.positive_prompt,
        negative: result.negative_prompt,
        meta: result.meta,
        review: result.review,
        feedback_analysis: {
          issue_types: feedbackAnalysis.issue_types,
          allowed_changes: feedbackAnalysis.allowed_changes,
          applied_fixes: feedbackAnalysis.extra_positive_notes.length > 0 || feedbackAnalysis.extra_negative_terms.length > 0,
        },
        source: "cloud_run_v9_refined",
      });
    }).catch(err => {
      sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "Route not found" });
}
