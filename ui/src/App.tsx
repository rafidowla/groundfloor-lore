import { useState } from 'react';
import { Settings, MessageSquare, Network, Moon, Sun } from 'lucide-react';
import GraphCanvas from './components/GraphCanvas';
import SigmaCanvas from './components/SigmaCanvas';
import './App.css';

function App() {
  const [theme, setTheme] = useState<'corporate' | 'midnight'>('corporate');
  const [showSettings, setShowSettings] = useState(false);
  const [useSigmaEngine, setUseSigmaEngine] = useState(true);

  const toggleTheme = () => {
    const newTheme = theme === 'corporate' ? 'midnight' : 'corporate';
    setTheme(newTheme);
    if (newTheme === 'midnight') {
      document.documentElement.classList.add('theme-developer-midnight');
    } else {
      document.documentElement.classList.remove('theme-developer-midnight');
    }
  };

  return (
    <div className="app-container">
      {/* Left Panel: Navigation & Chat */}
      <aside className="sidebar">
        <header className="sidebar-header">
          <div className="logo-area">
            <Network className="logo-icon" size={24} />
            <span className="logo-text">Lore Explorer</span>
          </div>
          <button className="icon-button" onClick={() => setShowSettings(!showSettings)} title="Settings">
            <Settings size={20} />
          </button>
        </header>
        
        <div className="chat-container">
          <div className="chat-history">
            <div className="chat-message ai-message glass-panel">
              <p>Welcome to Groundfloor Lore. The V2 Dataplane is connected.</p>
            </div>
          </div>
          
          <div className="chat-input-area">
            <div className="input-wrapper glass-panel">
              <input type="text" placeholder="Query the knowledge graph..." />
              <button className="send-button">
                <MessageSquare size={18} />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Graph Visualization Canvas Area */}
      <main className="canvas-area" style={{ position: 'relative' }}>
        {useSigmaEngine ? <SigmaCanvas /> : <GraphCanvas />}

        {/* Dynamic Settings Sidebar (Slide-over) */}
        {showSettings && (
          <div className="settings-panel glass-panel">
            <h3>Configuration</h3>
            
            <div className="setting-group">
              <label>Theme</label>
              <button className="theme-toggle" onClick={toggleTheme}>
                {theme === 'corporate' ? <Moon size={16} /> : <Sun size={16} />}
                <span>{theme === 'corporate' ? 'Switch to Midnight' : 'Switch to Corporate'}</span>
              </button>
            </div>

            <div className="setting-group">
              <label>Renderer Engine (Beta)</label>
              <button className="theme-toggle" onClick={() => setUseSigmaEngine(!useSigmaEngine)}>
                <Network size={16} />
                <span>{useSigmaEngine ? 'Revert to Vis-Network' : 'Try Sigma WebGL Engine'}</span>
              </button>
            </div>

            <div className="setting-group">
              <label>LLM Provider (Local UI)</label>
              <select className="ui-select">
                <option value="anthropic">Anthropic API (BYOK)</option>
                <option value="openai">OpenAI API (BYOK)</option>
                <option value="ollama">Local Ollama (localhost:11434)</option>
              </select>
            </div>

            <div className="setting-group">
              <label>API Key</label>
              <input type="password" placeholder="sk-..." className="ui-input" />
            </div>

            <div className="setting-group">
              <label>Workspace Account</label>
              <div className="account-switcher">
                <select className="ui-select" defaultValue="local">
                  <option value="local">Personal Local Account</option>
                  <option value="div" disabled>─── Cloud Workspaces ───</option>
                  <option value="login">+ Connect Groundfloor Cloud</option>
                </select>
                <p className="help-text" style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '0.25rem' }}>
                  Keep your lore local, or log in to sync with an enterprise Dataplane.
                </p>
              </div>
            </div>
            
            <button className="icon-button close-settings" onClick={() => setShowSettings(false)}>
              ✕
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
