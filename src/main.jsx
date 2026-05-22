import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Clapperboard,
  Download,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Sparkles,
  UserRound,
  Wand2
} from 'lucide-react';
import JSZip from 'jszip';
import {
  buildPromptForShot,
  emptyProject,
  normalizeProject,
  readFileAsDataUrl,
  shotCountForProject
} from './pipeline.js';
import './styles.css';

const statusLabels = {
  idle: 'Ready',
  working: 'Working',
  error: 'Error',
  done: 'Done'
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function useLocalProject() {
  const [project, setProject] = useState(() => {
    try {
      const stored = localStorage.getItem('pitchdeck-local-project') || localStorage.getItem('directors-console-local-project');
      return stored ? normalizeProject(JSON.parse(stored)) : emptyProject();
    } catch {
      return emptyProject();
    }
  });

  useEffect(() => {
    localStorage.setItem('pitchdeck-local-project', JSON.stringify(project));
  }, [project]);

  return [project, setProject];
}

function Field({ label, value, onChange, textarea = false, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {textarea ? (
        <textarea value={value} onChange={event => onChange(event.target.value)} />
      ) : (
        <input value={value} onChange={event => onChange(event.target.value)} />
      )}
      {children}
    </label>
  );
}

function SystemStatus({ status, refresh }) {
  const ollama = status?.ollama;
  const phosphene = status?.phosphene;
  const imageBackend = status?.imageBackend;
  return (
    <section className="panel status-grid">
      <div className={`status-card ${ollama?.ok ? 'online' : 'offline'}`}>
        <div>
          <strong>Ollama</strong>
          <span>{ollama?.ok ? `${ollama.models.length} model(s)` : ollama?.error || 'not reachable'}</span>
        </div>
        <code>{ollama?.url || 'http://127.0.0.1:11434'}</code>
      </div>
      <div className={`status-card ${phosphene?.ok ? 'online' : 'offline'}`}>
        <div>
          <strong>Phosphene</strong>
          <span>{phosphene?.ok ? `${phosphene.queueLength} queued · ${phosphene.historyCount} done` : phosphene?.error || 'not reachable'}</span>
        </div>
        <code>{phosphene?.url || 'http://127.0.0.1:8198'}</code>
      </div>
      <div className={`status-card ${imageBackend?.ok ? 'online' : 'offline'}`}>
        <div>
          <strong>Image Backend</strong>
          <span>{imageBackend?.reason || 'not configured'}{imageBackend?.modelSizeGb ? ` · ${imageBackend.modelSizeGb} GB` : ''}</span>
        </div>
        <code>{imageBackend?.name || 'adapter slot'}</code>
      </div>
      <button className="icon-button" onClick={refresh} title="Refresh backend status">
        <RefreshCw size={18} />
      </button>
    </section>
  );
}

function ModelManagerPanel({ models, onRefresh, onInstall, busy }) {
  return (
    <section className="panel model-panel">
      <div className="panel-title">
        <Download size={18} />
        <h2>Local Models</h2>
        <button className="icon-button" onClick={onRefresh} title="Refresh model status">
          <RefreshCw size={18} />
        </button>
      </div>
      <div className="model-list">
        {(models || []).map(model => {
          const installStatus = model.installStatus;
          const working = model.installing || installStatus?.status === 'running';
          return (
            <div className={`model-row ${model.installed ? 'installed' : 'missing'}`} key={model.id}>
              <div>
                <strong>{model.name}</strong>
                <span>{model.kind}</span>
                <code>{model.modelPath}</code>
              </div>
              <div className="model-actions">
                <span>{model.installed ? `Ready · ${model.sizeGb} GB` : model.sizeGb ? `${model.sizeGb} GB downloaded` : 'Not installed'}</span>
                {installStatus?.status === 'failed' ? <em>{installStatus.error || `Install failed (${installStatus.exitCode})`}</em> : null}
                {working ? <em>Installing in the background</em> : null}
                <button onClick={() => onInstall(model.id)} disabled={busy || working || model.installed}>
                  {working ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
                  {model.installed ? 'Installed' : 'Install / Repair'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ProgressBar({ progress }) {
  return (
    <section className="progress-panel">
      <div>
        <strong>{statusLabels[progress.kind] || 'Ready'}</strong>
        <span>{progress.message}</span>
      </div>
      <div className="bar">
        <i style={{ width: `${progress.value}%` }} />
      </div>
    </section>
  );
}

function ProjectForm({ project, setProject }) {
  const update = patch => setProject(current => normalizeProject({ ...current, ...patch }));
  return (
    <section className="panel form-panel">
      <div className="panel-title">
        <Clapperboard size={18} />
        <h2>Movie Setup</h2>
      </div>
      <div className="form-grid">
        <Field label="Title" value={project.movieTitle} onChange={movieTitle => update({ movieTitle })} />
        <Field label="Genre" value={project.genreIdea} onChange={genreIdea => update({ genreIdea })} />
        <Field label="Era / Setting" value={project.eraSetting} onChange={eraSetting => update({ eraSetting })} />
        <Field label="Photo Style" value={project.photoStyle} onChange={photoStyle => update({ photoStyle })} />
        <label className="field">
          <span>Minutes</span>
          <select value={project.minutesToExtract} onChange={event => update({ minutesToExtract: Number(event.target.value) })}>
            {[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value} minute{value > 1 ? 's' : ''}</option>)}
          </select>
        </label>
      </div>
      <Field label="Plot" value={project.plot} onChange={plot => update({ plot })} textarea />
      <div className="timing-note">
        {project.minutesToExtract} minute(s) = {shotCountForProject(project)} shots. Each minute is locked to 12 shots, each shot is 5 seconds.
      </div>
    </section>
  );
}

function CharacterCard({ character, onUpload }) {
  const physical = character.physical || {};
  const clothing = character.clothing || {};
  return (
    <article className="character-card">
      <div className="avatar">
        {character.faceRefDataUrl || character.avatarDataUrl ? (
          <img src={character.faceRefDataUrl || character.avatarDataUrl} alt="" />
        ) : (
          <UserRound size={28} />
        )}
      </div>
      <div className="character-body">
        <div className="character-head">
          <strong>{character.name}</strong>
          <span>{character.role}</span>
        </div>
        <p>{physical.age}, {physical.sex}. {physical.face}. {physical.hair}. {physical.eyes} eyes. {physical.bodyType} body type.</p>
        <p className="wardrobe">{clothing.description || `${clothing.shirtColor} ${clothing.shirtType}, ${clothing.pantsColor} ${clothing.pantsType}`}</p>
        <label className="small-upload">
          Upload face reference
          <input type="file" accept="image/*" onChange={event => onUpload(event.target.files?.[0])} />
        </label>
      </div>
    </article>
  );
}

function CharactersPanel({ project, setProject, onGenerate, busy }) {
  const uploadRef = async (characterId, file) => {
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    setProject(current => normalizeProject({
      ...current,
      characterProfiles: current.characterProfiles.map(character =>
        character.id === characterId ? { ...character, faceRefDataUrl: dataUrl } : character
      )
    }));
  };

  return (
    <section className="panel">
      <div className="panel-title">
        <UserRound size={18} />
        <h2>Reference Library</h2>
        <button onClick={onGenerate} disabled={busy}>
          {busy ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
          Generate Characters
        </button>
      </div>
      <div className="characters">
        {project.characterProfiles.length === 0 ? (
          <p className="empty">No character records yet. Generate them from the movie setup, then upload face references where you have them.</p>
        ) : (
          project.characterProfiles.map(character => (
            <CharacterCard
              key={character.id}
              character={character}
              onUpload={file => uploadRef(character.id, file)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function ScreenplayPanel({ project, setProject, onGenerate, busy }) {
  return (
    <section className="panel screenplay-panel">
      <div className="panel-title">
        <FileText size={18} />
        <h2>Screenplay</h2>
        <button onClick={onGenerate} disabled={busy || project.characterProfiles.length === 0}>
          {busy ? <Loader2 className="spin" size={16} /> : <Wand2 size={16} />}
          Generate Screenplay
        </button>
      </div>
      <textarea
        className="script-box"
        value={project.finalScript}
        placeholder="Generated screenplay appears here."
        onChange={event => setProject(current => normalizeProject({ ...current, finalScript: event.target.value }))}
      />
    </section>
  );
}

function ShotCard({ project, minute, shot, setProject, onGenerateImage, onQueueVideo, busy }) {
  const prompt = shot.generationPrompt || shot.prompt || '';

  const attachImage = async file => {
    if (!file) return;
    const imageDataUrl = await readFileAsDataUrl(file);
    setProject(current => normalizeProject({
      ...current,
      minutes: current.minutes.map(block => block.minuteNumber === minute.minuteNumber
        ? {
          ...block,
          shots: block.shots.map(item => item.id === shot.id ? { ...item, imageDataUrl } : item)
        }
        : block)
    }));
  };

  return (
    <article className="shot-card">
      <div className="shot-media">
        {shot.imageDataUrl || shot.imageUrl ? (
          <img src={shot.imageDataUrl || shot.imageUrl} alt="" />
        ) : (
          <div className="no-image">
            <ImageIcon size={22} />
            <span>No still yet</span>
          </div>
        )}
      </div>
      <div className="shot-body">
        <div className="shot-kicker">Minute {minute.minuteNumber} · Shot {shot.shotNumber} · 5 sec</div>
        <h3>{shot.subjectAction || 'Visible action pending'}</h3>
        <p><strong>Location:</strong> {shot.location}</p>
        <p><strong>Camera:</strong> {shot.camera}</p>
        <textarea value={prompt} readOnly />
        <div className="shot-actions">
          <label>
            Attach still
            <input type="file" accept="image/*" onChange={event => attachImage(event.target.files?.[0])} />
          </label>
          <button onClick={() => onGenerateImage(minute.minuteNumber, shot)} disabled={busy}>
            {busy ? <Loader2 className="spin" size={15} /> : <ImageIcon size={15} />}
            Generate Still
          </button>
          <button onClick={() => onQueueVideo(minute.minuteNumber, shot)} disabled={busy || !prompt}>
            <Play size={15} />
            Queue Video
          </button>
        </div>
      </div>
    </article>
  );
}

function StoryboardPanel({ project, setProject, onGenerateMinute, onBuildPrompts, onGenerateImage, onQueueVideo, busy }) {
  return (
    <section className="panel storyboard-panel">
      <div className="panel-title">
        <Film size={18} />
        <h2>Storyboard</h2>
        <div className="button-row">
          <button onClick={onGenerateMinute} disabled={busy || !project.finalScript}>
            {busy ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
            Generate Next Minute
          </button>
          <button onClick={onBuildPrompts} disabled={project.minutes.length === 0}>
            <Wand2 size={16} />
            Build Full Prompts
          </button>
        </div>
      </div>
      {project.minutes.length === 0 ? (
        <p className="empty">Generate the screenplay first, then generate minute blocks. Each block will create exactly 12 shots.</p>
      ) : (
        project.minutes.map(minute => (
          <div className="minute-block" key={minute.minuteNumber}>
            <h3>Minute {minute.minuteNumber} · {minute.shots.length} shots</h3>
            <div className="shots">
              {minute.shots.map(shot => (
                <ShotCard
                  key={shot.id}
                  project={project}
                  minute={minute}
                  shot={shot}
                  setProject={setProject}
                  onGenerateImage={onGenerateImage}
                  onQueueVideo={onQueueVideo}
                  busy={busy}
                />
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

function AgentFlowPanel({ flow }) {
  return (
    <section className="panel agent-panel">
      <div className="panel-title">
        <Sparkles size={18} />
        <h2>PitchDeck Flow</h2>
      </div>
      <div className="flow-list">
        {(flow?.nodes || []).map(node => (
          <div className="flow-node" key={node.id}>
            <strong>{node.id}</strong>
            <span>{node.role}</span>
            <code>{node.output}</code>
          </div>
        ))}
      </div>
    </section>
  );
}

function ExportPanel({ project, onSave }) {
  const exportZip = async () => {
    const zip = new JSZip();
    zip.file('project.json', JSON.stringify(project, null, 2));
    zip.file('screenplay.txt', project.finalScript || '');
    zip.file('prompts/storyboard_prompts.txt', project.minutes.flatMap(minute =>
      minute.shots.map(shot => `MINUTE ${minute.minuteNumber} SHOT ${shot.shotNumber}\n${shot.generationPrompt || shot.prompt || ''}\n`)
    ).join('\n'));
    project.minutes.forEach(minute => {
      minute.shots.forEach(shot => {
        if (!shot.imageDataUrl) return;
        const [, metadata, data] = shot.imageDataUrl.match(/^data:([^;]+);base64,(.*)$/) || [];
        if (!data) return;
        const ext = metadata?.includes('jpeg') ? 'jpg' : metadata?.split('/')[1] || 'png';
        zip.file(`images/minute-${minute.minuteNumber}-shot-${shot.shotNumber}.${ext}`, data, { base64: true });
      });
    });
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${project.movieTitle || 'movie'}-local-pipeline.zip`.replace(/[^a-z0-9._-]+/gi, '-');
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="panel export-panel">
      <div className="panel-title">
        <Download size={18} />
        <h2>Export</h2>
      </div>
      <div className="button-row">
        <button onClick={onSave}>
          <Save size={16} />
          Save Project
        </button>
        <button onClick={exportZip}>
          <Download size={16} />
          Download ZIP
        </button>
      </div>
    </section>
  );
}

function shotReferenceDataUrls(project, minuteNumber, shot) {
  const names = new Set((shot.charactersInShot || []).map(name => String(name).toLowerCase()));
  const text = `${shot.subjectAction || ''} ${shot.environmentDetails || ''} ${shot.location || ''}`.toLowerCase();
  const allCharacters = [...(project.characterProfiles || []), ...(project.extrasProfiles || [])];
  const characterRefs = allCharacters
    .filter(character => {
      const name = String(character.name || '').toLowerCase();
      return name && (names.has(name) || text.includes(name) || [...names].some(item => item.includes(name) || name.includes(item)));
    })
    .flatMap(character => [character.faceRefDataUrl, character.avatarDataUrl])
    .filter(Boolean);

  const locationRefs = (project.references || [])
    .filter(reference => {
      const name = String(reference.name || reference.label || '').toLowerCase();
      return name && text.includes(name);
    })
    .flatMap(reference => [reference.imageDataUrl, reference.dataUrl])
    .filter(Boolean);

  const previousShotRefs = [];
  for (const minute of project.minutes || []) {
    for (const item of minute.shots || []) {
      const isBefore = minute.minuteNumber < minuteNumber || (minute.minuteNumber === minuteNumber && item.shotNumber < shot.shotNumber);
      if (isBefore && item.imageDataUrl) previousShotRefs.push(item.imageDataUrl);
    }
  }

  return [...new Set([...characterRefs, ...locationRefs, ...previousShotRefs.reverse()])].slice(0, 4);
}

function App() {
  const [project, setProject] = useLocalProject();
  const [status, setStatus] = useState(null);
  const [models, setModels] = useState([]);
  const [flow, setFlow] = useState(null);
  const [busyTask, setBusyTask] = useState('');
  const [progress, setProgress] = useState({ kind: 'idle', message: 'Ready to build the local PitchDeck pipeline.', value: 0 });

  const model = useMemo(() => status?.ollama?.models?.includes('qwen3.5:latest')
    ? 'qwen3.5:latest'
    : status?.ollama?.models?.[0] || '', [status]);

  const refreshStatus = async () => {
    const data = await api('/api/status');
    setStatus(data);
  };

  const refreshModels = async () => {
    const data = await api('/api/models');
    setModels(data.models || []);
  };

  useEffect(() => {
    refreshStatus().catch(error => setProgress({ kind: 'error', message: error.message, value: 0 }));
    refreshModels().catch(() => {});
    api('/api/agents/flow').then(setFlow).catch(() => {});
  }, []);

  const runTask = async (task, message, fn) => {
    setBusyTask(task);
    setProgress({ kind: 'working', message, value: 25 });
    try {
      await fn();
      setProgress({ kind: 'done', message: `${message} complete.`, value: 100 });
    } catch (error) {
      setProgress({ kind: 'error', message: error.message, value: 100 });
    } finally {
      setBusyTask('');
    }
  };

  const generateCharacters = () => runTask('characters', 'Generating character profiles with Ollama', async () => {
    const data = await api('/api/agents/characters', {
      method: 'POST',
      body: JSON.stringify({ project, model })
    });
    setProject(current => normalizeProject({ ...current, characterProfiles: data.characters, extrasProfiles: data.extras || [] }));
  });

  const generateScreenplay = () => runTask('screenplay', 'Generating screenplay with locked characters', async () => {
    const data = await api('/api/agents/screenplay', {
      method: 'POST',
      body: JSON.stringify({ project, model })
    });
    setProject(current => normalizeProject({ ...current, finalScript: data.screenplay }));
  });

  const generateMinute = () => runTask('minute', 'Generating a 12-shot minute block', async () => {
    const nextMinute = project.minutes.length + 1;
    if (nextMinute > project.minutesToExtract) {
      throw new Error(`All ${project.minutesToExtract} minute(s) already exist.`);
    }
    const data = await api('/api/agents/minute', {
      method: 'POST',
      body: JSON.stringify({ project, minuteNumber: nextMinute, model })
    });
    setProject(current => normalizeProject({ ...current, minutes: [...current.minutes, data.minute] }));
  });

  const buildPrompts = () => runTask('prompts', 'Building full self-contained image prompts', async () => {
    setProject(current => normalizeProject({
      ...current,
      minutes: current.minutes.map(minute => ({
        ...minute,
        shots: minute.shots.map(shot => {
          const generationPrompt = buildPromptForShot({ project: current, minute, shot });
          return { ...shot, prompt: generationPrompt, generationPrompt };
        })
      }))
    }));
  });

  const installModel = modelId => runTask('model', 'Starting local model install or repair', async () => {
    await api(`/api/models/install/${modelId}`, { method: 'POST' });
    await refreshModels();
  });

  const generateShotImage = (minuteNumber, shot) => runTask('image', `Generating minute ${minuteNumber} shot ${shot.shotNumber} still with mflux`, async () => {
    const minute = project.minutes.find(item => item.minuteNumber === minuteNumber);
    if (!minute) throw new Error(`Minute ${minuteNumber} was not found.`);
    const prompt = shot.generationPrompt || shot.prompt || buildPromptForShot({ project, minute, shot });
    const imageDataUrls = shotReferenceDataUrls(project, minuteNumber, shot);
    if (imageDataUrls.length === 0) {
      throw new Error('Upload at least one character face/reference image, attach a previous still, or add a saved reference before generating this shot.');
    }
    const data = await api('/api/image/mflux/generate', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        imageDataUrls,
        label: `${project.movieTitle || 'film'}-m${minuteNumber}-s${shot.shotNumber}`,
        width: 1024,
        height: 576,
        steps: 12,
        lowRam: true
      })
    });
    setProject(current => normalizeProject({
      ...current,
      minutes: current.minutes.map(block => block.minuteNumber === minuteNumber
        ? {
          ...block,
          shots: block.shots.map(item => item.id === shot.id
            ? {
              ...item,
              prompt,
              generationPrompt: prompt,
              imageDataUrl: data.imageDataUrl,
              imageBackendOutputPath: data.outputPath
            }
            : item)
        }
        : block)
    }));
    await refreshStatus();
  });

  const queueVideo = (minuteNumber, shot) => runTask('video', `Queueing minute ${minuteNumber} shot ${shot.shotNumber} in Phosphene`, async () => {
    const prompt = shot.generationPrompt || shot.prompt;
    if (!prompt) throw new Error('Build the full shot prompt before queueing video.');
    await api('/api/video/phosphene/queue', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        imageDataUrl: shot.imageDataUrl || '',
        label: `${project.movieTitle || 'film'} minute ${minuteNumber} shot ${shot.shotNumber}`
      })
    });
    await refreshStatus();
  });

  const saveProject = () => runTask('save', 'Saving local project JSON', async () => {
    await api('/api/projects/save', {
      method: 'POST',
      body: JSON.stringify({ project })
    });
  });

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>PITCHDECK Local</h1>
          <p>Storyboard first. References locked. Local agents and Phosphene bridge wired.</p>
        </div>
        <div className="model-pill">{model ? `LLM: ${model}` : 'No local LLM detected'}</div>
      </header>

      <SystemStatus status={status} refresh={refreshStatus} />
      <ProgressBar progress={progress} />

      <div className="layout">
        <div className="main-column">
          <ProjectForm project={project} setProject={setProject} />
          <CharactersPanel project={project} setProject={setProject} onGenerate={generateCharacters} busy={busyTask === 'characters'} />
          <ScreenplayPanel project={project} setProject={setProject} onGenerate={generateScreenplay} busy={busyTask === 'screenplay'} />
          <StoryboardPanel
            project={project}
            setProject={setProject}
            onGenerateMinute={generateMinute}
            onBuildPrompts={buildPrompts}
            onGenerateImage={generateShotImage}
            onQueueVideo={queueVideo}
            busy={busyTask === 'minute' || busyTask === 'prompts' || busyTask === 'image' || busyTask === 'video'}
          />
        </div>
        <aside className="side-column">
          <AgentFlowPanel flow={flow} />
          <ModelManagerPanel
            models={models}
            onRefresh={refreshModels}
            onInstall={installModel}
            busy={busyTask === 'model'}
          />
          <ExportPanel project={project} onSave={saveProject} />
        </aside>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
