// index.js -- Cloud Run FUNCTIONS (Node 22 / ESM)
// Entry point: helloHttp
// GET  /health
// POST /prompt (or POST /)
//
// v8 — Motor inteligente com classifyProduct / resolveTemplate / autoScene / buildPrompt

import fs from "fs";
import path from "path";

///////////////////////
// ASCII-safe utils
///////////////////////
function asciiSafe(s = "", maxLen = 900) {
  let t = String(s || "");
  try { t = t.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""); } catch {}
  t = t
    .replace(/[""„‟]/g, '"')
    .replace(/[''‛‚]/g, "'")
    .replace(/[‐-‒–—―]/g, "-")
    .replace(/[`´]/g, "");
  t = t.replace(/[^\x20-\x7E]/g, "");
  t = t.trim().replace(/\s+/g, " ");
  if (t.length > maxLen) t = t.slice(0, maxLen).trim();
  return t;
}

function lower(s = "") { return asciiSafe(s, 500).toLowerCase(); }

function hasAny(text, arr) { return arr.some((k) => text.includes(k)); }

function hasWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(text);
}

function hasAnyWord(text, arr) { return arr.some((w) => hasWord(text, w)); }

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
// Rules loader
// Procura em rules/ primeiro, depois na raiz (suporte a ambos os layouts)
///////////////////////
const ROOT_DIR = process.cwd();
const RULE_CACHE = new Map();

function ruleFilePath(ruleName) {
  // Tenta rules/<name>.json primeiro (layout local)
  const inSubdir = path.join(ROOT_DIR, "rules", `${ruleName}.json`);
  if (fs.existsSync(inSubdir)) return inSubdir;
  // Fallback: <name>.json na raiz (layout Cloud Run deployed)
  return path.join(ROOT_DIR, `${ruleName}.json`);
}

function ruleFileExists(ruleName) {
  try { return fs.existsSync(ruleFilePath(ruleName)); } catch { return false; }
}

function loadRule(ruleName) {
  if (RULE_CACHE.has(ruleName)) return RULE_CACHE.get(ruleName);
  const p = ruleFilePath(ruleName);
  if (!fs.existsSync(p)) return null;
  try {
    const json = JSON.parse(fs.readFileSync(p, "utf8"));
    RULE_CACHE.set(ruleName, json);
    return json;
  } catch { return null; }
}

///////////////////////
// 1. classifyProduct
// Entende o produto e retorna o SLOT correto
///////////////////////
export function classifyProduct({ product_name = "", vision_description = "" } = {}) {
  const combined = `${product_name} ${vision_description}`.trim();
  return inferSlot(combined);
}

///////////////////////
// 2. resolveTemplate
// Mapeia slot → arquivo de rule real (suporta subpastas e nomes alternativos)
///////////////////////
const SLOT_TO_RULE = {
  // Wear → fashion/beleza
  wear_torso_full:   "display_fashion",
  wear_torso_upper:  "wear_torso",
  wear_waist_legs:   "wear_legs",
  wear_feet:         "wear_feet",
  wear_head_top:     "wear_head_top",
  wear_head_face:    "wear_face",
  wear_head_ear:     "wear_face",
  wear_neck:         "wear_neck",
  wear_wrist:        "display_beauty",
  wear_finger:       "display_beauty",
  wear_back:         "wear_back",
  wear_crossbody:    "wear_crossbody",

  // Hold
  hold_device:       "hold_device",
  hold_bag_hand:     "hold_hand",
  hold_tool_safe:    "hold_tool_safe",
  hold_food_display: "display_food",
  hold_sport_object: "scene_sport_ground",
  hold_display:      "display_product",
  hold_beauty_product: "display_beauty",
  hold_pet_product:  "display_product",
  hold_flower:       "scene_indoor_generic",
  hold_beverage:     "display_product",

  // Scene
  scene_tabletop:         "scene_home_tabletop",
  scene_home_indoor:      "scene_indoor_generic",
  scene_floor:            "scene_floor",
  scene_wall:             "scene_wall_fixed",
  scene_outdoor_ground:   "scene_outdoor_ground",
  scene_water_surface:    "scene_water_surface",
  scene_sport_environment:"scene_sport_ground",
  scene_vehicle_interior: "scene_indoor_generic",
  scene_store_shelf:      "scene_store_shelf",

  // Install
  install_home_fixture:    "install_home_fixture",
  install_vehicle_fixture: "install_vehicle_fixture",
  install_wall_fixed:      "install_wall_fixed",
};

export function resolveTemplate(slot) {
  const mapped = SLOT_TO_RULE[slot];
  if (mapped && ruleFileExists(mapped)) return mapped;
  // Fallback 1: tenta o slot direto como nome de arquivo
  if (ruleFileExists(slot)) return slot;
  // Fallback 2: fallbacks por família
  if (slot.startsWith("wear_")) {
    for (const fb of ["display_fashion", "wear_torso", "display_product"]) {
      if (ruleFileExists(fb)) return fb;
    }
  }
  if (slot.startsWith("hold_")) {
    for (const fb of ["display_product", "hold_hand"]) {
      if (ruleFileExists(fb)) return fb;
    }
  }
  if (slot.startsWith("install_")) {
    if (ruleFileExists("install_home_fixture")) return "install_home_fixture";
  }
  if (ruleFileExists("scene_home_tabletop")) return "scene_home_tabletop";
  if (ruleFileExists("display_product")) return "display_product";
  return null;
}

///////////////////////
// 3. autoScene
// Gera cena padrão quando o usuário não forneceu cenário
///////////////////////
export function autoScene(slot) {
  const scenes = {
    wear_head_top:    "lifestyle portrait, natural outdoor lighting",
    wear_head_face:   "lifestyle portrait, soft neutral background",
    wear_head_ear:    "close-up portrait, soft bokeh background",
    wear_neck:        "lifestyle portrait, soft neutral background",
    wear_torso_upper: "lifestyle environment, natural light",
    wear_torso_full:  "lifestyle environment, natural light, full body shot",
    wear_waist_legs:  "lifestyle environment, street or studio",
    wear_feet:        "walking or street scene, ground-level shot",
    wear_wrist:       "close-up lifestyle, neutral background",
    wear_finger:      "close-up of hand, elegant neutral background",
    wear_back:        "lifestyle environment, person facing away or to the side",
    wear_crossbody:   "lifestyle street environment",

    hold_device:       "modern lifestyle setting, person using device naturally",
    hold_bag_hand:     "lifestyle scene, street or cafe",
    hold_tool_safe:    "workshop or home environment, tool in use",
    hold_food_display: "clean kitchen or cafe countertop",
    hold_sport_object: "sports environment, outdoors",
    hold_display:      "clean commercial background, product centered",
    hold_beauty_product:"premium vanity or bathroom counter, elegant lighting",
    hold_pet_product:  "home environment with pet",
    hold_flower:       "natural light, outdoor or indoor lifestyle",
    hold_beverage:     "lifestyle setting, product held naturally",

    scene_tabletop:          "clean commercial tabletop, neutral background",
    scene_home_indoor:       "modern living room or home interior",
    scene_floor:             "modern living room floor, clean environment",
    scene_wall:              "clean interior wall, modern home",
    scene_outdoor_ground:    "outdoor natural environment, daylight",
    scene_water_surface:     "pool or beach, bright daylight",
    scene_sport_environment: "sports ground or gym, dynamic environment",
    scene_vehicle_interior:  "clean car interior",
    scene_store_shelf:       "retail store shelf, clean display",

    install_home_fixture:    "modern bathroom or home interior",
    install_vehicle_fixture: "clean car dashboard or engine bay",
    install_wall_fixed:      "clean interior wall, modern home",
  };
  return scenes[slot] || "clean commercial background, professional studio lighting";
}

///////////////////////
// Product type helpers
///////////////////////
function looksLikeFullBodyClothing(t) {
  return hasAny(t, [
    "vestido", "dress", "macacao", "macaquinho", "jardineira", "jumpsuit",
    "overall", "romper", "onesie", "pijama", "pijaminha", "pajama", "pyjama",
    "sleepwear", "roupa de dormir", "camisola", "nightgown", "baby doll",
    "babydoll", "conjunto pijama", "sleep set", "swimsuit", "maiô", "maio",
    "fantasia", "fantasia infantil", "sunga", "roupa de banho", "roupao", "robe",
  ]) || hasAnyWord(t, ["body"]);
}

function looksLikeUpperClothing(t) {
  return hasAny(t, [
    "camiseta", "camisa", "blusa", "regata", "cropped", "jaqueta", "moletom",
    "blazer", "colete", "cardigan", "sueter", "casaco", "t-shirt", "shirt",
    "hoodie", "sweatshirt", "polo", "uniforme", "kimono", "camisa social",
    "camisa polo", "bata", "suspensorio",
  ]) || hasAnyWord(t, ["top"]);
}

function looksLikeLowerClothing(t) {
  return hasAny(t, [
    "calca", "bermuda", "shorts", "short", "saia", "legging", "pants", "jeans",
    "jogger", "moletom calca", "trouser", "cueca boxer", "calcao", "short saia",
    "saia shorts", "saia-calca", "segunda pele calca", "cinto", "belt",
    "joelheira", "cotoveleira", "caneleira", "knee pad", "knee brace", "elbow pad",
  ]);
}

function looksLikeFeetClothing(t) {
  return hasAny(t, [
    "tenis", "sapato", "chinelo", "sandalia", "bota", "shoe", "shoes", "sneaker",
    "boot", "boots", "sandal", "sandals", "meia", "meias", "sock", "socks",
    "meiao", "pantufa", "slipper",
    // Calçados esportivos e de futebol
    "chuteira", "chuteiras", "football boot", "football boots", "soccer shoe", "soccer shoes",
    "soccer cleat", "soccer cleats", "cleat", "cleats", "bota de futebol", "bota esportiva",
    "sapatilha", "sapatilhas", "ballet flat", "loafer", "mocassim", "espadrille",
    "tennis shoe", "tennis sneaker", "men's tennis", "women's tennis",
  ]);
}

function looksLikeSetClothing(t) {
  return hasAny(t, [
    "conjunto", "conjuntinho", "conjunto de roupa", "conjunto infantil",
    "conjunto feminino", "conjunto masculino", "kit roupa", "kit de roupa",
    "look completo", "outfit set", "set de roupa",
  ]);
}

///////////////////////
// Context overrides (cenário anula o slot inferido)
///////////////////////

/** Usuário quer produto SEM modelo/pessoa → força display/scene sem humano */
function detectNoModel(text) {
  const t = lower(text);
  return hasAny(t, [
    "sem modelo", "sem pessoa", "sem pe ", "sem pe,", "sem pe.", "sem humano",
    "so o produto", "so a sandalia", "so o calcado", "so o sapato", "so o tenis",
    "so o chinelo", "so a bota", "so a chuteira", "so o cinto", "so a bolsa",
    "sem modelo so", "produto sozinho", "produto isolado", "produto apenas",
    "without model", "no model", "product only", "just the product",
    "no person", "no people", "no human", "without person",
    "sem pe de modelo", "so o item", "so o acessorio",
  ]);
}

/** Usuário quer modelo SEGURANDO o produto na mão (ex: sandália) → hold ao invés de wear */
function detectHoldInHand(text) {
  const t = lower(text);
  return hasAny(t, [
    "segurando", "segurando na mao", "na mao", "em maos", "holding",
    "hold", "na mão", "em mãos", "segurar na mao",
  ]);
}

///////////////////////
// Slot inference (classifyProduct interno)
///////////////////////
function inferSlot(produtoText) {
  const t = lower(produtoText);

  if (hasAny(t, ["luva", "glove", "gloves"])) return "wear_wrist";

  if (hasAny(t, [
    "conjunto de panelas", "kit de panelas", "jogo de panelas",
    "conjunto de talheres", "jogo de talheres", "jogo de cama", "jogo de banho",
  ])) return "scene_home_indoor";

  if (hasAny(t, [
    "lampada", "farol", "headlight", "h1", "h3", "h4", "h7", "h8", "h11",
    "hb3", "hb4", "xenon", "automotivo", "carro", "moto", "vehicle",
  ])) return "install_vehicle_fixture";

  if (hasAny(t, [
    "torneira", "chuveiro", "ducha", "tomada", "interruptor", "luminaria",
    "lampada de teto", "piso", "azulejo", "registro", "valvula",
    "encanamento", "fixture", "plumbing",
  ])) return "install_home_fixture";

  if (hasAny(t, [
    "suporte", "gancho", "prateleira", "porta toalha", "porta papel",
    "wall mount", "wall bracket", "fixacao",
  ])) return "install_wall_fixed";

  if (hasAny(t, [
    "celular", "smartphone", "iphone", "android", "tablet", "controle",
    "joystick", "gamepad", "camera", "gopro", "notebook", "laptop", "computador",
  ])) return "hold_device";

  if (hasAny(t, [
    "viseira", "visor", "bone", "chapeu", "touca", "tiara", "arquinho",
    "headband", "hat", "gorro", "beanie",
  ]) || hasAnyWord(t, ["cap"])) return "wear_head_top";

  if (hasAny(t, [
    "oculos", "glasses", "sunglasses", "mascara", "mask", "face shield",
  ]) || hasAnyWord(t, ["face"])) return "wear_head_face";

  if (hasAny(t, [
    "brinco", "earring", "argola", "piercing",
    "in-ear", "in ear", "earbud", "fone intra", "fone de ouvido intra",
  ])) return "wear_head_ear";

  if (hasAny(t, [
    "corrente", "gargantilha", "choker", "lenco", "scarf", "gravata",
  ]) || hasAnyWord(t, ["colar", "tie"])) return "wear_neck";

  if (hasAny(t, [
    "pulseira", "bracelet", "relogio", "watch", "smartwatch",
    "munhequeira", "wristband", "luva", "glove", "gloves",
    "luva de boxe", "luva de moto",
  ])) return "wear_wrist";

  if (hasAnyWord(t, ["anel", "ring"]) || hasAny(t, ["alianca"])) return "wear_finger";

  if (hasAny(t, ["mochila", "backpack"])) return "wear_back";
  if (hasAny(t, [
    "bolsa transversal", "crossbody", "tiracolo", "a tiracolo",
    "pochete transversal", "pochete", "fanny pack", "hip bag",
  ])) return "wear_crossbody";

  if (hasAny(t, [
    "biquini", "bikini", "lingerie", "sutia", "calcinha", "cueca",
    "cueca boxer", "roupa intima", "underwear", "undergarment",
    "sunga", "roupa de banho", "swimwear",
  ])) return "wear_torso_full";

  if (looksLikeFullBodyClothing(t)) return "wear_torso_full";
  if (looksLikeSetClothing(t)) return "wear_torso_full";

  if (hasAny(t, [
    "faca", "knife", "tesoura", "scissors", "canivete", "navalha", "lamina",
    "estilete", "box cutter", "martelo", "hammer", "chave de fenda",
    "chave inglesa", "wrench", "alicate", "pliers", "ferramenta",
  ])) return "hold_tool_safe";

  if (looksLikeUpperClothing(t)) return "wear_torso_upper";
  if (looksLikeLowerClothing(t)) return "wear_waist_legs";
  if (looksLikeFeetClothing(t)) return "wear_feet";

  if (hasAny(t, ["bolsa", "handbag", "sacola", "bolsa de mao", "carteira"])) return "hold_bag_hand";

  // Flores e buquês — antes de outros holds para evitar viés de "bride = flower crown"
  if (hasAny(t, [
    "buque", "bouquet", "ramalhete", "arranjo floral", "arranjo de flores",
    "floral arrangement", "flores do campo", "wildflowers",
    "astromelia", "girassol", "sunflower", "orquidea", "orchid",
    "margarida", "daisy", "lirio", "lily", "tulipa", "tulip",
    "peonia", "peony", "lavanda", "lavender", "rosas", "roses",
    "flower bouquet", "bridal bouquet", "wedding bouquet",
    "flores secas", "dried flowers", "flores artificiais", "artificial flowers",
  ]) || hasAnyWord(t, ["flor", "flores", "flower", "flowers", "floral"])) return "hold_flower";

  // Beleza, cosméticos, produtos capilares e de barbearia
  if (hasAny(t, [
    "perfume", "fragrance", "cologne", "eau de parfum", "eau de toilette",
    "creme", "cream", "locao", "lotion", "serum", "tonico", "tonic",
    "hidratante", "moisturizer", "protetor solar", "sunscreen", "spf",
    "maquiagem", "makeup", "batom", "lipstick", "esmalte", "nail polish",
    "sombra olhos", "eye shadow", "delineador", "eyeliner", "rimel",
    "blush", "contour", "highlighter", "base maquiagem", "foundation",
    "sabonete liquido", "body wash", "gel de banho", "shower gel",
    "shampoo", "condicionador", "conditioner", "mascara capilar",
    "oleo capilar", "hair oil", "leave-in", "queratina",
    "creme facial", "face cream", "toner", "micellar",
    // Capilares e barbearia
    "descolorante", "po descolorante", "oxidante", "tinta de cabelo",
    "coloracao capilar", "tintura", "hair dye", "hair color",
    "bleach powder", "bleaching powder", "pomada capilar", "gel capilar",
    "finalizador", "hair wax", "hair gel", "relaxamento", "alisamento",
    "botox capilar", "progressiva", "barber product", "barbershop product",
  ])) return "hold_beauty_product";

  // Bebidas
  if (hasAny(t, [
    "bebida", "drink", "beverage", "suco", "juice", "nectar",
    "refrigerante", "soda", "energetico", "energy drink",
    "vinho", "wine", "espumante", "sparkling wine", "champagne",
    "cerveja", "beer", "chopp", "ale", "lager",
    "whisky", "whiskey", "bourbon", "rum", "vodka", "gin", "tequila",
    "cachaca", "licor", "liqueur", "agua de coco", "coconut water",
    "capsula de cafe", "coffee capsule", "coffee pod",
    "garrafa", "bottle", "lata de", "can of",
  ])) return "hold_beverage";

  // Pet
  if (hasAny(t, [
    "coleira", "collar", "guia de cachorro", "leash", "pet", "cachorro", "gato",
    "racao", "dog food", "cat food", "petisco", "pet treat", "brinquedo pet",
    "cama pet", "caixa de areia", "arranhador", "bebedouro pet", "comedouro pet",
  ])) return "hold_pet_product";

  // Suplementos / medicamentos
  if (hasAny(t, [
    "suplemento", "supplement", "whey", "creatina", "creatine", "proteina", "protein",
    "vitamina", "vitamin", "omega", "colageno", "collagen", "prebiotico", "probiotico",
    "termogenico", "thermogenic", "bcaa", "aminoacido", "amino acid",
    "remedio", "medicine", "medicamento", "comprimido", "tablet", "capsula medicamento",
  ])) return "hold_beauty_product";

  if (hasAny(t, ["bola", "ball", "halter", "dumbbell", "peso", "raquete", "racket", "bodyboard", "skate", "patins"])) return "hold_sport_object";
  if (hasAny(t, ["bolo", "torta", "doce", "brigadeiro", "salgado", "pizza", "hamburguer", "hamburger", "food", "snack"])) return "hold_food_display";
  if (hasAny(t, ["boia", "inflavel", "piscina", "pool", "water", "aquatico", "aquatic"])) return "scene_water_surface";
  if (hasAny(t, ["campo", "quadra", "soccer", "football", "basketball", "sport", "treino", "training"])) return "scene_sport_environment";
  if (hasAny(t, ["painel", "volante", "vehicle interior", "interior do carro"])) return "scene_vehicle_interior";
  if (hasAny(t, ["quadro", "espelho", "parede", "wall art"])) return "scene_wall";
  if (hasAny(t, ["tapete", "carpet", "rug", "chao", "floor"])) return "scene_floor";
  if (hasAny(t, ["expositor", "shelf", "store", "loja", "gondola"])) return "scene_store_shelf";

  if (hasAny(t, [
    "porta retrato", "porta-retrato", "decoracao", "enfeite", "vaso", "abajur",
    "organizador", "vela", "difusor", "aromatizador", "porta-velas", "incenso",
    "jogo de cama", "lencol", "fronha", "edredom", "colcha", "manta",
    "capa de almofada", "almofada", "travesseiro", "toalha", "toalha de banho",
    "toalha de rosto", "roupao de banho", "panela", "frigideira", "wok",
    "cacarola", "utensilio de cozinha", "conjunto de panelas", "kit de panelas",
    "forma de assar", "assadeira", "faca de cozinha", "talheres",
    "conjunto de talheres", "porta objetos", "caixa organizadora",
  ])) return "scene_home_indoor";

  if (hasAny(t, ["jardim", "grama", "outdoor", "externo", "quintal", "rua"])) return "scene_outdoor_ground";

  return "scene_tabletop";
}

///////////////////////
// Persona inference (com plus size)
///////////////////////
function inferPersona(text) {
  const t = lower(text);

  const isBaby = hasAny(t, ["bebe", "beb", "baby", "newborn", "recem nascido", "recem-nascido", "recem nascida", "recem-nascida", "nenem", "onesie", "romper"]);
  const isChild = hasAny(t, ["infantil", "crianca", "criancas", "child", "children", "kid", "kids", "menino", "menina"]);
  const isTeen = hasAny(t, ["teen", "adolescente", "jovem", "juvenil", "teenager"]);
  const isMale = hasAny(t, ["masculino", "homem", "menino", "boy", "male", "man", "masc", "noivo", "groom"]);
  const isFemale = hasAny(t, ["feminino", "mulher", "menina", "girl", "female", "woman", "fem", "noiva", "bride", "dama"]);
  const unisex = hasAny(t, ["unissex", "unisex"]);
  const isPlusSize = hasAny(t, ["plus size", "plus-size", "plussize", "gordinha", "gordinho", "curvy", "curvilinea", "size plus"]);

  let age = "adult";
  if (isBaby) age = "baby";
  else if (isChild) age = "child";
  else if (isTeen) age = "teen";

  let gender = "unisex";
  if (unisex) gender = "unisex";
  else if (isMale && !isFemale) gender = "male";
  else if (isFemale && !isMale) gender = "female";

  let subject = "a person";
  if (age === "baby") subject = "a baby";
  else if (age === "child") subject = gender === "male" ? "a boy" : gender === "female" ? "a girl" : "a child";
  else if (age === "teen") subject = gender === "male" ? "a teenage boy" : gender === "female" ? "a teenage girl" : "a teenager";
  else if (isPlusSize) subject = gender === "male" ? "a plus-size man" : gender === "female" ? "a plus-size woman" : "a plus-size person";
  else subject = gender === "male" ? "a man" : gender === "female" ? "a woman" : "a person";

  return { subject, age, gender };
}

function normalizeProductLabel(produtoText) {
  const t = asciiSafe(produtoText, 140);
  const tl = lower(t);
  const removeWords = [
    "masculino", "feminino", "unissex", "infantil", "crianca", "criancas",
    "bebe", "beb", "adulto", "adulta", "adult", "kids", "kid", "child",
    "children", "baby", "homem", "mulher", "menino", "menina", "tamanho",
    "tam", "size", "numero", "num", "cor", "color", "original", "premium",
    "novo", "nova", "new", "kit", "combo", "look", "outfit",
  ];
  let cleaned = tl;
  for (const w of removeWords) {
    cleaned = cleaned.replace(new RegExp(`\\b${w}\\b`, "g"), " ");
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  const label = asciiSafe(cleaned, 80);
  return label.length >= 3 ? label : asciiSafe(produtoText, 80) || "the product";
}

///////////////////////
// Prompt helpers
///////////////////////
const DISPLAY_ONLY_HOLD = new Set([
  "hold_beauty_product", "hold_pet_product", "hold_food_display",
  "hold_display", "hold_beverage", "hold_flower",
]);

function referenceRequired(slot) {
  return (slot.startsWith("wear_") || slot.startsWith("hold_")) && !DISPLAY_ONLY_HOLD.has(slot);
}

function forceHuman(slot, mannequinDetected) {
  return referenceRequired(slot) || mannequinDetected;
}

function scaleBlock(slot) {
  if (slot.startsWith("wear_") || slot.startsWith("hold_")) {
    return [
      "Human reference is mandatory to define scale.",
      "The human reference must clearly communicate the real-world size of the product.",
      "Use a relevant body part as scale reference.",
      "The product must look realistically sized compared to the human reference.",
    ];
  }
  return ["The product must keep realistic size and proportion in the scene."];
}

function antiInventBlock(slot) {
  const neg = [
    "Do not invent decorations, fantasy elements, costumes, props, or themed add-ons.",
    "No floating product.",
    "No unrealistic glamour effects.",
  ];
  if (slot.startsWith("wear_")) {
    neg.push("No product-only photo. No packshot. Do not show the product alone.");
  }
  return neg;
}

///////////////////////
// 4. buildPrompt — motor central de geração de prompts
///////////////////////
export function buildPrompt({
  slot,
  product_name,
  scene_request,
  vision_description,
  persona,
  mannequinDetected = false,
}) {
  const ruleName = resolveTemplate(slot);
  const rule = ruleName ? loadRule(ruleName) : null;

  // Escolhe cena: explícita do usuário > autoScene()
  const scene = scene_request?.trim() || autoScene(slot);

  const prodLabel = normalizeProductLabel(product_name || vision_description || "the product");
  const visionAnchor = vision_description ? asciiSafe(vision_description, 200) : null;

  const refReq = referenceRequired(slot);
  const forceHum = forceHuman(slot, mannequinDetected);

  const pos = [];
  const neg = [];

  // Bloco identidade (obrigatório)
  pos.push("Realistic commercial photo.");
  pos.push(`Product: ${visionAnchor || prodLabel}.`);
  pos.push(
    "The product must remain visually identical to the reference image.",
    "Do not change color, shape, texture, or design.",
  );

  // Cena/contexto
  if (scene) {
    pos.push(`Scene/context: ${asciiSafe(scene, 200)}.`);
    pos.push(
      "Use the scenario only as realistic environment support.",
      "The product must remain the main focus of the image.",
    );
  }

  // Sujeito humano
  if (forceHum && persona) {
    pos.push(`Subject: ${persona.subject}.`);
    pos.push(
      "HUMAN REFERENCE REQUIRED.",
      "Use a real human. Replace any mannequin, bust, head form, or dummy with a real human.",
    );
  }

  // Bloco de posição física (anti-float)
  const positionMap = {
    wear_head_top:    `The ${prodLabel} is worn on the top of the head, correct orientation and realistic scale.`,
    wear_head_face:   `The ${prodLabel} is worn on the face, correctly aligned with facial features.`,
    wear_head_ear:    `The ${prodLabel} is attached to the earlobe, close-up ear shot.`,
    wear_neck:        `The ${prodLabel} is worn around the neck.`,
    wear_torso_upper: `The ${prodLabel} is worn on the upper body.`,
    wear_torso_full:  `The ${prodLabel} is worn as a full-body garment.`,
    wear_waist_legs:  `The ${prodLabel} is worn on the lower body.`,
    wear_feet:        `The ${prodLabel} is worn on the feet, ground-level shot.`,
    wear_wrist:       `The ${prodLabel} is worn on the wrist.`,
    wear_finger:      `The ${prodLabel} is worn on a finger, close-up.`,
    wear_back:        `The ${prodLabel} is worn on the back.`,
    wear_crossbody:   `The ${prodLabel} is worn crossbody.`,
    hold_device:      `The ${prodLabel} is held naturally in one hand.`,
    hold_bag_hand:    `The ${prodLabel} is held in one hand.`,
    hold_tool_safe:   `The ${prodLabel} is held safely in hand.`,
    hold_sport_object:`The ${prodLabel} is used in sport context.`,
    hold_flower:      `The ${prodLabel} is held with both hands at chest level.`,
    hold_beverage:    `The ${prodLabel} is held at chest level.`,
    scene_floor:      `The ${prodLabel} is placed flat on the floor.`,
    scene_wall:       `The ${prodLabel} is mounted or placed against the wall.`,
    scene_outdoor_ground: `The ${prodLabel} is placed on outdoor ground.`,
    install_home_fixture:    `The ${prodLabel} is installed in the correct position.`,
    install_vehicle_fixture: `The ${prodLabel} is installed in the correct vehicle position.`,
    install_wall_fixed:      `The ${prodLabel} is fixed to the wall at the correct height.`,
  };
  if (positionMap[slot]) pos.push(positionMap[slot]);
  else pos.push(`The ${prodLabel} is placed or used in a natural, realistic position.`);

  // Rules do template JSON
  if (rule?.pos_add && Array.isArray(rule.pos_add)) pos.push(...rule.pos_add);
  if (rule?.neg_add && Array.isArray(rule.neg_add)) neg.push(...rule.neg_add);

  // Bloco qualidade
  pos.push(
    "Realistic lighting, natural shadows, correct scale.",
    "High-quality commercial photo, sharp focus on product.",
  );

  // Anti-duplicação
  pos.push("The product appears only once in the image.");

  // Bloco de tamanho/escala
  pos.push(...scaleBlock(slot));

  // Remoção de mão (quando não é slot de hold)
  if (!slot.startsWith("hold_")) {
    pos.push("If a hand or fingers are present in the input photo, remove them. Keep only the product.");
    neg.push("No hands. No fingers.");
  } else {
    neg.push("No extra hands. Only one hand.");
  }

  // Identidade do produto — negativo
  neg.push(
    "floating, duplicate, packaging, barcode, label, altered design, wrong color, wrong shape, wrong position, blurry, low quality, CGI, cartoon, text, watermark.",
    "Do not change, redesign, stylize, resize, warp, or distort the product.",
    "No duplicate product.",
    "No extra objects distracting from the product.",
  );

  if (forceHum) {
    neg.push("No mannequin. No bust. No head form. No dummy. No display stand.");
  }

  neg.push(...antiInventBlock(slot));

  return {
    positive: asciiSafe(pos.join(" "), 1200),
    negative: asciiSafe(neg.join(" "), 1200),
    rule_used: ruleName,
    reference_required: refReq,
    force_human: forceHum,
    scene_used: scene,
  };
}

///////////////////////
// Mannequin detection
///////////////////////
function detectMannequinFromText(text) {
  const t = lower(text);
  return hasAny(t, [
    "manequim", "mannequin", "busto", "bust", "cabeca", "headform",
    "head form", "dummy", "display", "expositor", "suporte de exposicao",
  ]);
}

///////////////////////
// Entry point
///////////////////////
export const helloHttp = async (req, res) => {
  try {
    if (setCors(req, res)) return;

    const pathname = (req.path || req.url || "/").split("?")[0];

    if (req.method === "GET" && pathname === "/health") {
      const rootFiles = fs.readdirSync(ROOT_DIR).filter((f) => f.endsWith(".json"));
      const rulesDir = path.join(ROOT_DIR, "rules");
      const ruleFiles = fs.existsSync(rulesDir)
        ? fs.readdirSync(rulesDir).filter((f) => f.endsWith(".json"))
        : [];
      return sendJson(res, 200, {
        ok: true,
        service: "tamo-ai-brain-v8-motor-inteligente",
        cwd: ROOT_DIR,
        root_json_files: rootFiles.length,
        rules_subdir_files: ruleFiles.length,
        total_rules: rootFiles.length + ruleFiles.length,
        sample_files: [...rootFiles, ...ruleFiles].slice(0, 50),
      });
    }

    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "Use POST /prompt (or POST /) or GET /health" });
    }

    if (!(pathname === "/" || pathname === "/prompt")) {
      return sendJson(res, 404, { ok: false, error: "Not found" });
    }

    const body = await readJsonBody(req);

    const produtoRaw =
      body?.produto ?? body?.produto_frase ?? body?.product ?? body?.name ?? body?.product_name ?? "";
    const cenarioRaw =
      body?.cenario ?? body?.scenario ?? body?.scene ?? body?.contexto ?? body?.scene_request ?? "";
    const visionRaw = body?.vision_desc ?? body?.vision ?? body?.vision_description ?? "";

    const produto = asciiSafe(produtoRaw, 180);
    const cenario = asciiSafe(cenarioRaw, 220);
    const vision  = visionRaw ? asciiSafe(visionRaw, 300) : "";

    if (!produto && !vision) {
      return sendJson(res, 400, { ok: false, error: "Missing produto/product/product_name" });
    }

    const productForInfer = produto || vision;

    // Slot manual (override externo)
    let slot = asciiSafe(body?.usage_anchor || "", 64);
    const hadManualSlot = Boolean(slot);
    if (slot && !SLOT_TO_RULE[slot] && !ruleFileExists(slot)) slot = "";

    // ── classifyProduct: infere slot do produto ──────────────────────────────
    const rawInferredSlot = classifyProduct({ product_name: productForInfer, vision_description: vision });

    if (!slot) slot = rawInferredSlot;

    // ── Context overrides: cenário anula o slot ───────────────────────────────
    const combinedContext = `${productForInfer} ${cenario}`.trim();
    if (slot.startsWith("wear_") && detectNoModel(combinedContext)) {
      slot = "scene_tabletop";
    } else if (slot === "wear_feet" && detectHoldInHand(cenario)) {
      slot = "hold_bag_hand";
    }

    const mannequinDetected = Boolean(body?.mannequinDetected) || detectMannequinFromText(combinedContext);
    const persona = inferPersona(combinedContext);

    // ── buildPrompt: monta prompts com template correto ──────────────────────
    const { positive, negative, rule_used, reference_required, force_human, scene_used } = buildPrompt({
      slot,
      product_name: produto || vision,
      scene_request: cenario,
      vision_description: vision || null,
      persona,
      mannequinDetected,
    });

    return sendJson(res, 200, {
      ok: true,
      positive,
      negative,
      produto,
      cenario,
      usage_anchor: slot,
      meta: {
        manual_slot_received: hadManualSlot,
        raw_inferred_slot: rawInferredSlot,
        final_slot: slot,
        rule_used,
        reference_required,
        force_human,
        mannequin_detected: mannequinDetected,
        scene_used,
        subject: persona.subject,
        age: persona.age,
        gender: persona.gender,
        product_label: normalizeProductLabel(produto || vision),
      },
    });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e?.message || e) });
  }
};
