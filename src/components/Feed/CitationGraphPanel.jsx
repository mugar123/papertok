import React, { useState, useEffect } from 'react';
import { X, Loader2, Link, BookOpen, Quote, ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import { getPaperCitationsAndReferences } from '../../services/semanticScholarService';
import { motion } from 'framer-motion';
import './CitationGraphPanel.css';

export default function CitationGraphPanel({ paper, onClose, onOpenPdf }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({ references: [], citations: [] });
  const [activeTab, setActiveTab] = useState('references'); // 'references' or 'citations'

  useEffect(() => {
    let mounted = true;
    async function fetchData() {
      setLoading(true);
      try {
        const result = await getPaperCitationsAndReferences(paper.arxivId);
        if (mounted) {
          setData(result);
        }
      } catch (err) {
        console.error(err);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    fetchData();
    return () => { mounted = false; };
  }, [paper.arxivId]);

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handlePaperClick = (p) => {
    if (p.arxivId) {
      onOpenPdf({
        id: `http://arxiv.org/abs/${p.arxivId}`,
        arxivId: p.arxivId,
        title: p.title,
        authors: p.authors,
        summary: 'No abstract available in citation view.',
        published: `${p.year}-01-01T00:00:00Z`
      });
    }
  };

  const list = activeTab === 'references' ? data.references : data.citations;

  return (
    <motion.div 
      className="cgp-backdrop" 
      onClick={handleBackdropClick}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div 
        className="cgp-container"
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", bounce: 0, duration: 0.4 }}
      >
        {/* Header */}
        <div className="cgp-header">
          <div className="cgp-header-top">
            <h2 className="cgp-title">Grafo de Conocimiento</h2>
            <button className="cgp-close-btn" onClick={onClose}>
              <X size={24} />
            </button>
          </div>
          <p className="cgp-subtitle">{paper.title}</p>
          
          <div className="cgp-tabs">
            <button 
              className={`cgp-tab ${activeTab === 'references' ? 'active' : ''}`}
              onClick={() => setActiveTab('references')}
            >
              <BookOpen size={16} /> Referencias ({data.references.length})
            </button>
            <button 
              className={`cgp-tab ${activeTab === 'citations' ? 'active' : ''}`}
              onClick={() => setActiveTab('citations')}
            >
              <Quote size={16} /> Citado por ({data.citations.length})
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="cgp-content custom-scrollbar">
          {loading ? (
            <div className="cgp-loading">
              <Loader2 className="spinning" size={32} />
              <p>Analizando red semántica...</p>
            </div>
          ) : list.length > 0 ? (
            <div className="cgp-list">
              {list.map((p, idx) => (
                <div 
                  key={idx} 
                  className={`cgp-item ${p.arxivId ? 'clickable' : ''}`}
                  onClick={() => handlePaperClick(p)}
                >
                  <div className="cgp-item-icon">
                    {p.arxivId ? <FileText size={18} /> : <Link size={18} />}
                  </div>
                  <div className="cgp-item-info">
                    <h4 className="cgp-item-title">{p.title}</h4>
                    <p className="cgp-item-authors">
                      {p.authors.slice(0, 3).join(', ')}{p.authors.length > 3 ? ' et al.' : ''} • {p.year}
                    </p>
                    {p.arxivId && <span className="cgp-item-badge">arXiv:{p.arxivId}</span>}
                  </div>
                  {p.arxivId && (
                    <div className="cgp-item-arrow">
                      <ChevronRight size={18} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="cgp-empty">
              <p>No se encontraron {activeTab === 'references' ? 'referencias' : 'citas'} para este paper en Semantic Scholar.</p>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
