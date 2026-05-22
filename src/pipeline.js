export function emptyProject() {
  return {
    id: '',
    movieTitle: '',
    plot: '',
    genreIdea: 'cinematic drama',
    eraSetting: 'present day',
    photoStyle: 'cinematic realistic',
    minutesToExtract: 1,
    characterProfiles: [],
    extrasProfiles: [],
    references: [],
    finalScript: '',
    minutes: []
  };
}

export function normalizeProject(project = {}) {
  return {
    ...emptyProject(),
    ...project,
    minutesToExtract: Math.min(5, Math.max(1, Number(project.minutesToExtract || 1))),
    characterProfiles: Array.isArray(project.characterProfiles) ? project.characterProfiles : [],
    extrasProfiles: Array.isArray(project.extrasProfiles) ? project.extrasProfiles : [],
    references: Array.isArray(project.references) ? project.references : [],
    minutes: Array.isArray(project.minutes) ? project.minutes.map(normalizeMinute) : []
  };
}

function normalizeMinute(minute = {}) {
  const number = Number(minute.minuteNumber || 1);
  const shots = Array.isArray(minute.shots) ? minute.shots.slice(0, 12) : [];
  return {
    ...minute,
    minuteNumber: number,
    durationSeconds: 60,
    sceneCanon: Array.isArray(minute.sceneCanon) ? minute.sceneCanon : [],
    shots: shots.map((shot, index) => ({
      id: shot.id || `m${number}-s${index + 1}`,
      durationSeconds: 5,
      shotNumber: index + 1,
      location: shot.location || 'scripted location',
      interiorExterior: shot.interiorExterior || inferInteriorExterior(shot.location),
      timeOfDay: shot.timeOfDay || 'scripted time of day',
      lighting: shot.lighting || 'scripted lighting source',
      visualStyle: shot.visualStyle || '',
      camera: shot.camera || 'medium shot at eye level',
      subjectAction: stripNonVisualLanguage(shot.subjectAction || shot.action || ''),
      environmentDetails: shot.environmentDetails || 'scripted environment details',
      charactersInShot: listify(shot.charactersInShot),
      propsInShot: listify(shot.propsInShot),
      prompt: shot.prompt || '',
      generationPrompt: shot.generationPrompt || '',
      imageDataUrl: shot.imageDataUrl || '',
      imageUrl: shot.imageUrl || ''
    }))
  };
}

function listify(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[,;|]/).map(item => item.trim()).filter(Boolean);
  }
  return [];
}

export function shotCountForProject(project) {
  return Math.max(1, Number(project.minutesToExtract || 1)) * 12;
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function valueOrNA(value) {
  if (value === undefined || value === null) return 'N/A';
  const str = String(value).trim();
  if (!str || /^null|undefined$/i.test(str)) return 'N/A';
  return str;
}

export function stripNonVisualLanguage(text = '') {
  return String(text || '')
    .replace(/["“”'‘’][^"“”'‘’]{0,240}["“”'‘’]/g, '')
    .replace(/\b(says|said|tells|told|speaks|spoke|shouts|shouted|whispers|whispered|dialogue|sound|music|hears|heard|voiceover|voice-over)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function referenceTag(name) {
  const clean = String(name || '').trim();
  return clean ? `@${clean.replace(/\s+/g, '')}` : '';
}

function inferInteriorExterior(location = '', explicit = '') {
  if (explicit) return explicit;
  const text = String(location).toLowerCase();
  if (/\b(int|inside|interior|room|kitchen|bedroom|office|hallway|cafeteria|classroom|bathroom|store|house|apartment|car)\b/.test(text)) return 'interior';
  if (/\b(ext|outside|exterior|street|yard|road|parking|forest|beach|field|sidewalk|porch|driveway)\b/.test(text)) return 'exterior';
  return 'interior or exterior as scripted';
}

function buildWardrobeDescription(clothing = {}) {
  const pieces = [];
  if (valueOrNA(clothing.shirtColor) !== 'N/A' || valueOrNA(clothing.shirtType) !== 'N/A') {
    pieces.push(`shirt: ${valueOrNA(clothing.shirtColor)} ${valueOrNA(clothing.shirtType)}`.trim());
  }
  if (valueOrNA(clothing.pants) !== 'N/A' || valueOrNA(clothing.pantsColor) !== 'N/A' || valueOrNA(clothing.pantsType) !== 'N/A') {
    pieces.push(`pants: ${valueOrNA(clothing.pants)} ${valueOrNA(clothing.pantsColor)} ${valueOrNA(clothing.pantsType)} ${valueOrNA(clothing.pantsLength)}`.trim());
  }
  if (valueOrNA(clothing.skirt) !== 'N/A' || valueOrNA(clothing.skirtColor) !== 'N/A') {
    pieces.push(`skirt: ${valueOrNA(clothing.skirt)} ${valueOrNA(clothing.skirtColor)} ${valueOrNA(clothing.skirtType)} ${valueOrNA(clothing.skirtLength)}`.trim());
  }
  if (valueOrNA(clothing.shorts) !== 'N/A' || valueOrNA(clothing.shortsColor) !== 'N/A') {
    pieces.push(`shorts: ${valueOrNA(clothing.shorts)} ${valueOrNA(clothing.shortsColor)} ${valueOrNA(clothing.shortsType)} ${valueOrNA(clothing.shortsLength)}`.trim());
  }
  if (valueOrNA(clothing.shoes) !== 'N/A') pieces.push(`shoes: ${valueOrNA(clothing.shoes)}`);
  if (valueOrNA(clothing.accessories) !== 'N/A') pieces.push(`accessories: ${valueOrNA(clothing.accessories)}`);
  return pieces.length ? pieces.join('; ') : 'N/A';
}

export function buildCharacterSpec(character = {}) {
  const physical = character.physical || {};
  const clothing = character.clothing || {};
  return [
    `${referenceTag(character.name)} ${valueOrNA(character.name)}, age ${valueOrNA(physical.age)}, ${valueOrNA(physical.sex)}, role ${valueOrNA(character.role)}.`,
    `Face: ${valueOrNA(physical.face)}; hair: ${valueOrNA(physical.hair)}; eyes: ${valueOrNA(physical.eyes)}; nose: ${valueOrNA(physical.nose)}; mouth: ${valueOrNA(physical.mouth)}; body: ${valueOrNA(physical.body)}; body type: ${valueOrNA(physical.bodyType)}; skin tone: ${valueOrNA(physical.skinTone)}.`,
    `Locked wardrobe: SHIRT COLOR ${valueOrNA(clothing.shirtColor)}; SHIRT TYPE ${valueOrNA(clothing.shirtType)}; PANTS ${valueOrNA(clothing.pants)}; PANTS COLOR ${valueOrNA(clothing.pantsColor)}; PANTS TYPE ${valueOrNA(clothing.pantsType)}; PANTS LENGTH ${valueOrNA(clothing.pantsLength)}; SKIRT ${valueOrNA(clothing.skirt)}; SKIRT COLOR ${valueOrNA(clothing.skirtColor)}; SKIRT TYPE ${valueOrNA(clothing.skirtType)}; SKIRT LENGTH ${valueOrNA(clothing.skirtLength)}; SHORTS ${valueOrNA(clothing.shorts)}; SHORTS COLOR ${valueOrNA(clothing.shortsColor)}; SHORTS TYPE ${valueOrNA(clothing.shortsType)}; SHORTS LENGTH ${valueOrNA(clothing.shortsLength)}; SHOES ${valueOrNA(clothing.shoes)}; ACCESSORIES ${valueOrNA(clothing.accessories)}.`,
    `Wardrobe description: ${valueOrNA(clothing.description) !== 'N/A' ? clothing.description : buildWardrobeDescription(clothing)}.`,
    character.faceRefDataUrl || character.avatarDataUrl ? 'Use the uploaded primary face/reference image as the identity source.' : 'No accessible image input is attached; preserve this written locked identity exactly.'
  ].join(' ');
}

function findVisibleCharacters(project, shot) {
  const names = new Set(listify(shot.charactersInShot).map(name => String(name).toLowerCase()));
  const all = [...(project.characterProfiles || []), ...(project.extrasProfiles || [])];
  const matched = all.filter(character => {
    const name = String(character.name || '').toLowerCase();
    if (!name) return false;
    if (names.has(name)) return true;
    return [...names].some(shotName => shotName.includes(name) || name.includes(shotName));
  });
  return matched.length ? matched : all.filter(character => {
    const haystack = `${shot.subjectAction} ${shot.environmentDetails}`.toLowerCase();
    return haystack.includes(String(character.name || '').toLowerCase());
  });
}

function findSceneCanon(minute, shot) {
  const canon = Array.isArray(minute.sceneCanon) ? minute.sceneCanon : [];
  return canon.find(scene => scene.id && scene.id === shot.sceneId)
    || canon.find(scene => scene.location && scene.location === shot.location)
    || null;
}

export function buildPromptForShot({ project, minute, shot }) {
  const scene = findSceneCanon(minute, shot);
  const location = shot.location || scene?.location || 'the exact scripted location';
  const interiorExterior = shot.interiorExterior || scene?.interiorExterior || inferInteriorExterior(location);
  const timeOfDay = shot.timeOfDay || scene?.timeOfDay || 'the scripted time of day';
  const lighting = shot.lighting || scene?.lighting || 'the scripted practical lighting source';
  const environmentDetails = shot.environmentDetails || scene?.environmentDetails || `${project.eraSetting} production design`;
  const visualStyle = shot.visualStyle || project.photoStyle || 'cinematic realistic';
  const action = stripNonVisualLanguage(shot.subjectAction || 'the exact visible action from the screenplay beat');
  const characters = findVisibleCharacters(project, shot);
  const props = [...(scene?.props || []), ...(shot.propsInShot || [])].filter(Boolean);
  const locationReference = referenceTag(location);

  const characterText = characters.length
    ? characters.map(buildCharacterSpec).join(' ')
    : 'No visible named main character is required in this frame; background people, if present, remain generic extras appropriate to the scene.';

  const propText = props.length
    ? `Visible props and objects: ${props.map(prop => `${referenceTag(prop)} ${prop}`).join(', ')}.`
    : 'Visible props and objects are only those required by the screenplay action, with no invented symbolic clutter.';

  return [
    `${interiorExterior === 'interior' ? 'Inside' : interiorExterior === 'exterior' ? 'Outside' : 'At'} ${locationReference} ${location}, ${timeOfDay}, lit by ${lighting}.`,
    `This is the locked scripted location for "${project.movieTitle || 'the film'}", with ${environmentDetails}.`,
    characterText,
    propText,
    `Exact visible action: ${action}.`,
    `Camera and lens: ${shot.camera || 'medium cinematic shot at eye level with a natural 50mm lens'}.`,
    `Production style: ${visualStyle}; script-accurate geography, readable staging, continuity-preserving wardrobe, no random genre drift, no invented time of day, no unrelated location substitution.`,
    'Visual-only image prompt: no dialogue text, subtitles, sound cues, music cues, watermarks, bracketed templates, null values, or placeholder language.'
  ].join(' ');
}
