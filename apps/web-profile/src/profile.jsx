import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createRemoteServiceBinding } from "../../../packages/chord/src/index.ts";
import { BACKGROUND_CONTEXT } from "../../../packages/chord/src/context/index.ts";
import { Client, createClientServiceTransport, createHttpTransportFactory } from "../../../packages/client/src/index.ts";
import { SessionDirectory, SessionManagement } from "../../../packages/coding-agent/src/experimental/services/sessions.ts";
import { Transcript } from "../../../packages/coding-agent/src/experimental/services/transcript.ts";
import { AgentController } from "../../../packages/coding-agent/src/experimental/services/agent-controller.ts";
import { Models } from "../../../packages/coding-agent/src/experimental/services/models.ts";
import { AppFrame } from "../../../vendor/deepseek-web/packages/client/ui-layout/src/client/AppFrame.tsx";
import { SidebarRoot } from "../../../vendor/deepseek-web/packages/client/ui-sidebar/src/client/SidebarRoot.tsx";
import { HeroShell } from "../../../vendor/deepseek-web/packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx";
import { UserContent } from "../../../vendor/deepseek-web/packages/client/ui-chat/src/client/chat/UserContent.tsx";
import { UserTextRun } from "./dsh-primitives.js";
import { MarkdownText } from "../../../vendor/deepseek-web/packages/client/ui-primitives/src/markdown/MarkdownText.tsx";
import "../../../vendor/deepseek-web/packages/client/ui-theme/src/styles/base.css";
import "../../../vendor/deepseek-web/packages/client/ui-theme/src/styles/design-platform.css";
import "../../../vendor/deepseek-web/packages/client/ui-theme/src/styles/focus.css";
import "../../../vendor/deepseek-web/packages/client/ui-theme/src/styles/scrollbar.css";
import "./profile.css";

const labels = { title: "Earendil", connect: "连接", token: "本地访问令牌", server: "Server ID", sessions: "会话", create: "新建会话", send: "发送", stop: "停止", prompt: "输入消息", disconnected: "未连接", connected: "已连接", details: "模型与用量", select: "选择一个会话开始", local: "本地用量", quota: "订阅额度", unknown: "尚未接入数据源", error: "操作失败", license: "DeepSeek MIT 许可证" };
const dictionary = { "toggle.open": "展开侧栏", "toggle.collapse": "收起侧栏", "brand.localBuild": "Earendil", "session.new.label": "新建会话", "session.new": "新对话", "panels.label": "导航", "hero.headline": "有什么可以帮你？", "hero.preview": "", "message.extraBlock": "消息内容" };
const t = key => dictionary[key] ?? key;
const markdownLabels = { code: { copyLabel: "复制代码", copiedLabel: "已复制" }, footnotes: "脚注" };

function ConversationMessages({ transcript }) {
  if (!transcript || transcript.entries.length === 0) return <HeroShell t={t} renderSlot={(_name, _props, options) => options?.fallback ?? null} />;
  return <>{transcript.entries.map(entry => <React.Fragment key={entry.id}>{(entry.model ?? []).map((message, index) => {
    if (message.role === "user") {
      const text = typeof message.content === "string" ? message.content : (message.content ?? []).filter(block => block.type === "text").map(block => block.text).join("");
      return <div className="user-message" key={index}><UserContent content={{ text, attachments: [], extraBlocks: [] }} renderFactorySlot={(_name, props) => <UserTextRun text={props.text} />} renderSlot={() => null} t={t} /></div>;
    }
    return <article className="assistant-message" key={index}><MarkdownText labels={markdownLabels} text={typeof message.content === "string" ? message.content : (message.content ?? []).map(block => block.type === "text" ? block.text : JSON.stringify(block, null, 2)).join("\n")} /></article>;
  })}</React.Fragment>)}</>;
}
const launch = new URLSearchParams(location.hash.slice(1));
const initialToken = launch.get("token") ?? "";
const initialServer = launch.get("serverId") ?? "";
history.replaceState(null, "", location.pathname);
let connection;
let serverBinding;
let sessionBinding;
let unsubscribeDirectory;
let unsubscribeTranscript;
let unsubscribeModels;

function App() {
  const [token, setToken] = useState(initialToken);
  const [serverId, setServerId] = useState(initialServer);
  const [status, setStatus] = useState(labels.disconnected);
  const [error, setError] = useState("");
  const [sessions, setSessions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [transcript, setTranscript] = useState(null);
  const [models, setModels] = useState(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [layoutInfo, setLayout] = useState({ viewportWidth: innerWidth, sidebar: 280, rightbar: 340, narrowExpanded: false, rightbarShown: true, rightbarTrack: true, rightbarFullscreen: false, rightbarInstant: false });
  const actions = useMemo(() => ({
    setViewportWidth: value => setLayout(previous => previous.viewportWidth === value ? previous : { ...previous, viewportWidth: value }),
    setSidebar: value => setLayout(previous => ({ ...previous, sidebar: value })),
    setRightbar: value => setLayout(previous => ({ ...previous, rightbar: value })),
  }), []);
  const run = async operation => { setError(""); setBusy(true); try { await operation(); } catch (failure) { setError(failure instanceof Error ? failure.message : labels.error); } finally { setBusy(false); } };
  const connect = async () => {
    unsubscribeDirectory?.(); unsubscribeTranscript?.(); unsubscribeModels?.();
    await sessionBinding?.dispose(BACKGROUND_CONTEXT);
    await serverBinding?.dispose(BACKGROUND_CONTEXT);
    await connection?.dispose();
    connection = undefined; serverBinding = undefined; sessionBinding = undefined;
    setSelected(null); setTranscript(null); setModels(null); setSessions([]);
    connection = await Client.connect({ serverId, transportFactory: createHttpTransportFactory({ baseUrl: location.origin, token }) });
    connection.onConnectionStateChange(change => { setStatus(change.state === "connected" ? labels.connected : labels.disconnected); if (change.state === "disconnected") setSelected(null); });
    serverBinding = createRemoteServiceBinding({ services: [SessionDirectory, SessionManagement], transport: createClientServiceTransport(connection, () => ({ serverId })), onError: failure => setError(failure.message) });
    const directory = serverBinding.use(SessionDirectory);
    await serverBinding.ready(BACKGROUND_CONTEXT);
    unsubscribeDirectory = directory.state.subscribe(value => setSessions(value.sessions));
    setStatus(labels.connected);
  };
  const attach = async id => {
    setSelected(null); setTranscript(null); setModels(null);
    unsubscribeTranscript?.(); unsubscribeModels?.();
    await sessionBinding?.dispose(BACKGROUND_CONTEXT);
    sessionBinding = undefined;
    await serverBinding.use(SessionManagement).attach(id, BACKGROUND_CONTEXT);
    sessionBinding = createRemoteServiceBinding({ services: [Transcript, AgentController, Models], transport: createClientServiceTransport(connection, () => connection.attachment), onError: failure => setError(failure.message) });
    const conversation = sessionBinding.use(Transcript);
    const model = sessionBinding.use(Models);
    await sessionBinding.ready(BACKGROUND_CONTEXT);
    unsubscribeTranscript = conversation.state.subscribe(setTranscript);
    unsubscribeModels = model.state.subscribe(setModels);
    setSelected(id);
  };
  useEffect(() => {
    if (initialToken && initialServer) void run(connect);
  }, []);
  const useStore = selector => selector({ layoutInfo });
  const useSessions = selector => selector({ byId: Object.fromEntries(sessions.map(session => [session.sessionId, { id: session.sessionId, title: session.sessionId, retainedBy: { mainView: session.sessionId === selected ? 1 : 0 } }])) });
  const usePanelInfo = useCallback(selector => selector({ activePanelId: null }), []);
  const renderSlot = (name, props) => {
    if (name === "sidebar") return <SidebarRoot {...props} t={t} usePanels={selector => selector([])} useShortcuts={selector => selector([])} usePanelInfo={usePanelInfo} selectPanel={() => {}} toggleSidebar={() => setLayout(previous => ({ ...previous, narrowExpanded: !previous.narrowExpanded, sidebar: previous.sidebar === 0 ? 280 : 0 }))} startSession={() => { if (!serverBinding || busy || status !== labels.connected) return; run(async () => { const created = await serverBinding.use(SessionManagement).create({}, BACKGROUND_CONTEXT); await attach(created.sessionId); }); }} renderSlot={(slot, owner, options) => {
      if (slot === "sidebar.workspaces") return owner.wide && <nav className="session-list"><p>{labels.sessions}</p>{sessions.map(session => <button key={session.sessionId} aria-current={selected === session.sessionId} disabled={busy || status !== labels.connected} onClick={() => run(() => attach(session.sessionId))}>{session.sessionId}</button>)}</nav>;
      if (slot === "sidebar.settings") return owner.wide && <a className="license" href="/LICENSE.deepseek">{labels.license}</a>;
      return options?.fallback ?? null;
    }} />;
    if (name === "main") return <main><header><strong>{selected ?? labels.title}</strong><span>{status}</span></header>{status !== labels.connected && <form onSubmit={event => { event.preventDefault(); run(connect); }}><label>{labels.server}<input required value={serverId} onChange={event => setServerId(event.target.value)} /></label><label>{labels.token}<input required type="password" value={token} onChange={event => setToken(event.target.value)} /></label><button disabled={busy}>{labels.connect}</button></form>}{error && <p role="alert">{error}</p>}<section className="conversation"><ConversationMessages transcript={transcript} /></section><form className="composer" onSubmit={event => { event.preventDefault(); const message = draft; run(async () => { const result = await sessionBinding.use(AgentController).prompt({ message, images: null }, BACKGROUND_CONTEXT); if (!result.accepted) throw new Error(result.error.message); setDraft(""); }); }}><textarea aria-label={labels.prompt} placeholder={labels.prompt} value={draft} onChange={event => setDraft(event.target.value)} /><button disabled={!selected || busy || !draft.trim()}>{labels.send}</button><button type="button" disabled={!selected || busy} onClick={() => run(() => sessionBinding.use(AgentController).abort(BACKGROUND_CONTEXT))}>{labels.stop}</button></form></main>;
    if (name === "rightbar") return props.canShow && <section className="details"><h2>{labels.details}</h2><pre>{JSON.stringify(models?.configuration ?? {}, null, 2)}</pre><h3>{labels.local}</h3><pre>{JSON.stringify(transcript?.docs?.["pi.usage"] ?? {}, null, 2)}</pre><h3>{labels.quota}</h3><p>{labels.unknown}</p></section>;
    return null;
  };
  return <AppFrame useStore={useStore} useSessions={useSessions} usePanelInfo={usePanelInfo} actions={actions} renderSlot={renderSlot} t={() => labels.title} />;
}

addEventListener("pagehide", () => { void connection?.dispose(); });
createRoot(document.getElementById("root")).render(<App />);
