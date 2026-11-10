import '../../web/src/storage-migration';
import './zh';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useAppearance } from '../../web/src/hooks';
import { MODES } from '../../web/src/appearance';
import { copyText } from '../../web/src/clipboard';
import { Popover } from '../../web/src/components/Popover';
import { AgentMark, IconAgents, IconArrowRight, IconCheck, IconComputer, IconCopy, IconGlobe, IconPalette, IconRestore, IconBoard, IconSparkle, IconHandover, IconHand, IconShield } from '../../web/src/components/icons';
import { ANTIGRAVITY_ICON, CLAUDE_ICON, CODEX_ICON, PI_ICON, TRAE_ICON, ZCODE_ICON } from '../../daemon/src/adapters/icons';
import { EXAMPLES, DEFAULT_EXAMPLE } from './scenarios';
import '../../web/src/styles.css';
import './site.css';
import { zh as copy } from '../../web/src/i18n/locales/site/zh';
import { PLUGINS } from './plugins';

const REPOSITORY = 'https://github.com/maxliux5/calli';
const INSTALL = 'curl -fsSL https://raw.githubusercontent.com/maxliux5/calli/main/install.sh | bash';
const agents = [
  { name: 'TRAE CLI', icon: TRAE_ICON }, { name: 'zcode', icon: ZCODE_ICON },
  { name: 'Codex', icon: CODEX_ICON }, { name: 'Claude Code', icon: CLAUDE_ICON },
  { name: 'pi', icon: PI_ICON }, { name: 'Antigravity', icon: ANTIGRAVITY_ICON },
];

function Home() {
  const [appearance, setAppearance, theme] = useAppearance('calli.site.appearance');
  const frame = useRef<HTMLIFrameElement>(null);
  const frameArea = useRef<HTMLDivElement>(null);
  const [started, setStarted] = useState(false);
  const [active, setActive] = useState<string>(DEFAULT_EXAMPLE.id);
  const [source, setSource] = useState(() => `./demo/?scene=${DEFAULT_EXAMPLE.id}&theme=${theme}`);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'copy' | 'copied' | 'copyFailed'>('copy');
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  const sendTheme = () => frame.current?.contentWindow?.postMessage({ type: 'calli:theme', theme }, location.origin);
  useEffect(() => {
    if (started || !frameArea.current) return;
    if (!('IntersectionObserver' in window)) { setStarted(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setStarted(true); observer.disconnect(); }
    }, { threshold: 0.1 });
    observer.observe(frameArea.current);
    return () => observer.disconnect();
  }, [started]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === 'calli:ready') { sendTheme(); setReady(true); setFailed(false); }
      if (event.data?.type === 'calli:scene' && EXAMPLES.some(s => s.id === event.data.scene)) setActive(event.data.scene);
      if (event.data?.type === 'calli:focus') frame.current?.scrollIntoView({ block: 'center' });
      if (event.data?.type === 'calli:install') document.getElementById('install')?.scrollIntoView({ behavior: 'smooth' });
    };
    window.addEventListener('message', receive);
    sendTheme();
    return () => window.removeEventListener('message', receive);
  }, [theme]);
  useEffect(() => {
    if (!started || ready) return;
    const timer = setTimeout(() => setFailed(true), 15_000);
    return () => clearTimeout(timer);
  }, [source, ready, started]);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const loadScene = (scene: string) => {
    setStarted(true); setActive(scene); setReady(false); setFailed(false);
    setSource(`./demo/?scene=${scene}&theme=${theme}&restart=${Date.now()}`);
  };
  const tryExample = (id: string) => {
    loadScene(id);
    document.getElementById('experience')?.scrollIntoView({ behavior: 'smooth' });
  };
  const copyCommands = async () => {
    setCopyStatus(await copyText(INSTALL) ? 'copied' : 'copyFailed');
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyStatus('copy'), 2500);
  };

  return <>
    <a className="site-skip" href="#experience" onClick={() => setStarted(true)}>{copy.skip}</a>
    <header className="site-nav">
      <nav className="site-wrap" aria-label={copy.nav}>
        <a className="site-brand" href="#"><img src="./calli-icon.png?v=crab-1" alt="" width="32" height="32" />Calli</a>
        <div className="site-links">
          <a href="#experience" onClick={() => setStarted(true)}>{copy.experience}</a>
          <a href="#collaboration">{copy.collaboration}</a>
          <a href="#extensions">{copy.extensions}</a>
          <a href="#contribute">{copy.participate}</a>
          <a href={REPOSITORY} target="_blank" rel="noopener noreferrer">GitHub <span className="site-outward"><IconArrowRight size={12} /></span></a>
        </div>
        <Popover label={copy.appearance} triggerLabel={copy.appearance} triggerClassName="site-theme" trigger={<IconPalette size={18} />} align="end">
          {close => <>{MODES.map(mode => <button key={mode.id} className="pop-item" role="menuitemradio" aria-checked={appearance.mode === mode.id} onClick={() => { setAppearance({ mode: mode.id, palette: 'paper' }); close(); }}><span>{mode.name}</span>{appearance.mode === mode.id && <IconCheck size={15} />}</button>)}</>}
        </Popover>
        <a className="site-button site-button-small" href="#install">{copy.install}</a>
      </nav>
    </header>

    <main>
      <section className="site-hero site-wrap" aria-labelledby="hero-title">
        <p className="site-eyebrow">{copy.eyebrow}</p>
        <h1 id="hero-title">{copy.heroFirst}<br /><span>{copy.heroSecond}</span></h1>
        <p className="site-lede"><span>{copy.ledeFirst}</span><span>{copy.ledeSecond}</span></p>
        <div className="site-actions">
          <a className="site-button" href="#experience" onClick={() => setStarted(true)}>{copy.tryNow} <IconArrowRight size={17} /></a>
          <a className="site-button site-button-secondary" href="#extensions">{copy.explorePlugins}</a>
        </div>
        <p className="site-meta">{copy.meta}</p>
      </section>

      <section className="site-experience site-wrap" id="experience" aria-labelledby="experience-title">
        <div className="site-section-head"><div><p className="site-eyebrow">{copy.experienceEyebrow}</p><h2 id="experience-title">{copy.experienceTitle}</h2></div><p>{copy.experienceDescription}</p></div>
        <div className="site-demo-window">
          <div className="site-demo-toolbar">
            <div className="site-demo-tabs" role="group" aria-label={copy.chooseTask}>{EXAMPLES.map((scenario, i) => <button key={scenario.id} aria-pressed={active === scenario.id} onClick={() => loadScene(scenario.id)}><span className="site-step-number">0{i + 1}</span>{scenario.label}</button>)}</div>
            <div className="site-demo-tools"><button title={copy.restart} aria-label={copy.restart} onClick={() => loadScene(active)}><IconRestore size={17} /></button><a className="site-open-demo" href={`./demo/?scene=${active}&theme=${theme}`} target="_blank" rel="noopener noreferrer" title={copy.newWindow} aria-label={copy.newWindow}><IconGlobe size={17} /><span>{copy.fullScreen}</span></a></div>
          </div>
          <div className="site-frame-area" ref={frameArea}>
            {started && <iframe key={source} ref={frame} src={source} title={copy.iframeTitle} className={ready ? 'is-ready' : ''} onError={() => setFailed(true)} />}
            {!ready && <div className="site-frame-loading" role="status"><img src="./calli-icon.png?v=crab-1" alt="" width="56" height="56" /><p>{failed ? copy.loadFailed : started ? copy.loading : copy.loadPrompt}</p>{(failed || !started) && <button className="site-button site-button-small" onClick={() => loadScene(active)}>{failed ? copy.reload : copy.startDemo}</button>}</div>}
          </div>
        </div>
        <p className="site-demo-note">{copy.demoNote}<span>{copy.ownProject}<a href="#install">{copy.install} <IconArrowRight size={13} /></a></span></p>
        <div className="site-agents" aria-label={copy.supportedAgents}>{agents.map(agent => <span key={agent.name}><AgentMark path={agent.icon} size={18} />{agent.name}</span>)}</div>
        <p className="site-agent-note">{copy.agentNote}</p>
      </section>

      <section className="site-features site-wrap" id="collaboration" aria-labelledby="features-title">
        <div className="site-section-head"><div><p className="site-eyebrow">{copy.featuresEyebrow}</p><h2 id="features-title">{copy.collaborationTitle}</h2></div></div>
        <p className="site-section-intro">{copy.collaborationDescription}</p>
        <div className="site-collaboration-flow">
          {[
            { icon: CLAUDE_ICON, name: 'Claude Code', role: copy.collaborationRoleLead },
            { icon: CODEX_ICON, name: 'Codex', role: copy.collaborationRoleBuild },
            { icon: PI_ICON, name: 'pi', role: copy.collaborationRoleReview },
          ].map(member => <div className="site-collaboration-role" key={member.name}><AgentMark path={member.icon} size={22} /><div><strong>{member.name}</strong><span>{member.role}</span></div></div>)}
        </div>
        <div className="site-collaboration-actions"><button className="site-button" onClick={() => tryExample('collaboration')}>{copy.collaborationTry}<IconArrowRight size={16} /></button><p>{copy.collaborationExampleNote}</p></div>
        <div className="site-feature-grid">
          {[
            { Icon: IconAgents, title: copy.manageTitle, description: copy.manageDescription, detail: copy.manageDetail },
            { Icon: IconComputer, title: copy.mobileTitle, description: copy.mobileDescription, detail: copy.mobileDetail },
          ].map(({ Icon, title, description, detail }) => <article key={title}>
            <div className="site-feature-icon"><Icon size={24} /></div><h3>{title}</h3><p>{description}</p>
            <p className="site-feature-footnote">{detail}</p>
          </article>)}
        </div>
      </section>

      <section className="site-features site-handover-feature site-wrap" id="handover" aria-labelledby="handover-title">
        <div className="site-section-head"><div><p className="site-eyebrow">{copy.handover}</p><h2 id="handover-title">{copy.handoverTitle}</h2></div></div>
        <p className="site-section-intro">{copy.handoverDescription}</p>
        <div className="site-collaboration-actions"><button className="site-button" onClick={() => tryExample('handover')}>{copy.handoverTry}<IconArrowRight size={16} /></button><p>{copy.handoverModelNote}</p></div>
        <div className="site-feature-grid">
          {[
            { Icon: IconHandover, title: copy.handoverAccounts, description: copy.handoverAccountsDescription },
            { Icon: IconHand, title: copy.handoverMention, description: copy.handoverMentionDescription },
            { Icon: IconShield, title: copy.handoverMinimal, description: copy.handoverMinimalDescription },
          ].map(({ Icon, title, description }) => <article key={title}>
            <div className="site-feature-icon"><Icon size={24} /></div><h3>{title}</h3><p>{description}</p>
          </article>)}
        </div>
      </section>

      <section className="site-extensions site-wrap" id="extensions" aria-labelledby="extensions-title">
        <div className="site-section-head"><div><p className="site-eyebrow">{copy.pluginEyebrow}</p><h2 id="extensions-title">{copy.pluginTitle}</h2></div></div>
        <p className="site-section-intro">{copy.pluginIntro}</p>
        <div className="site-plugin-grid" aria-label={copy.pluginCatalog}>
          {PLUGINS.map(plugin => {
            const Icon = { board: IconBoard, memory: IconSparkle, loopx: IconRestore }[plugin.id];
            return <article className="site-plugin" key={plugin.id} data-plugin={plugin.id}>
              <div className="site-plugin-heading"><Icon size={22} /><span>{plugin.kind}</span></div>
              <h3>{plugin.title}</h3><p>{plugin.description}</p>
              <p className="site-plugin-note">{plugin.note}</p>
              {(plugin.id === 'board' || plugin.id === 'memory') && <button className="site-plugin-try" onClick={() => tryExample(plugin.id)}>{plugin.id === 'board' ? copy.boardExample : copy.memoryExample}<IconArrowRight size={15} /></button>}
              <a href={`${REPOSITORY}/blob/main/docs/contributing-extensions.md#${plugin.id}`} target="_blank" rel="noopener noreferrer" aria-label={`${copy.pluginReadMore} · ${plugin.title}`}>{copy.pluginReadMore}<IconArrowRight size={15} /></a>
            </article>;
          })}
        </div>
        <div className="site-resources"><div><h3>{copy.resourcesTitle}</h3><p>{copy.resourcesDescription}</p></div><a href={`${REPOSITORY}/blob/main/docs/contributing-extensions.md#选择一种参与方式`} target="_blank" rel="noopener noreferrer">{copy.resourcesLink}<IconArrowRight size={15} /></a></div>
        <p className="site-roadmap"><span>{copy.upNext}</span>{copy.roadmap} <a href={`${REPOSITORY}/blob/main/docs/TODO.md#6-扩展机制`} target="_blank" rel="noopener noreferrer">{copy.roadmapLink}<IconArrowRight size={12} /></a></p>
      </section>

      <section className="site-community site-wrap" id="contribute" aria-labelledby="community-title">
        <div className="site-community-inner">
          <div><p className="site-eyebrow">{copy.communityEyebrow}</p><h2 id="community-title">{copy.communityFirst}<br /><span>{copy.communitySecond}</span></h2></div>
          <div className="site-community-copy"><p>{copy.communityDescription}</p>
            <div className="site-community-actions"><a className="site-button" href={`${REPOSITORY}/blob/main/docs/contributing-extensions.md`} target="_blank" rel="noopener noreferrer">{copy.contributePlugin}<IconArrowRight size={16} /></a><a className="site-button site-button-secondary" href={`${REPOSITORY}/issues/new`} target="_blank" rel="noopener noreferrer">{copy.shareNeed}</a></div>
            <p className="site-community-note">{copy.contributionNote}</p>
          </div>
        </div>
      </section>

      <section className="site-install site-wrap" id="install" aria-labelledby="install-title">
        <div><p className="site-eyebrow">{copy.installEyebrow}</p><h2 id="install-title">{copy.installFirst}<br />{copy.installSecond}</h2><p>{copy.installDescription}</p><p className="site-install-requirement">{copy.installRequirement}</p><a className="site-doc-link" href={`${REPOSITORY}#快速开始`} target="_blank" rel="noopener noreferrer">{copy.installDocs}<IconArrowRight size={16} /></a></div>
        <div className="site-install-guide"><div className="site-code-card"><div className="site-code-head"><span>{copy.terminal}</span><button onClick={() => void copyCommands()} aria-live="polite">{copyStatus === 'copied' ? <IconCheck size={14} /> : <IconCopy size={14} />}{copy[copyStatus]}</button></div><pre><code>{INSTALL}</code></pre></div>
          <ol className="site-install-steps"><li>{copy.openLocal} <code>http://127.0.0.1:8787/</code></li><li>{copy.connect}</li><li>{copy.remote} <a href={`${REPOSITORY}#远程访问`} target="_blank" rel="noopener noreferrer">{copy.remoteDocs}</a></li></ol>
        </div>
      </section>
    </main>
    <footer className="site-footer site-wrap"><a className="site-brand" href="#"><img src="./calli-icon.png?v=crab-1" alt="" width="28" height="28" />Calli</a><span>{copy.footer}</span><div><a href={REPOSITORY} target="_blank" rel="noopener noreferrer">{copy.source}</a><a href={`${REPOSITORY}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">{copy.license}</a></div></footer>
  </>;
}

createRoot(document.getElementById('root')!).render(<Home />);
