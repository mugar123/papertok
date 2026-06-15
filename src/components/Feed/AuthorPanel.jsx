import React, { useState, useEffect } from 'react';
import { getAuthorWikiInfo } from '../../services/wikiService';
import { getAuthorPapers } from '../../services/arxivService';
import { getAuthorProfile } from '../../services/openAlexService';
import { X, ChevronLeft, ExternalLink, Loader2, BookOpen, Award, Building2 } from 'lucide-react';
import { getCategoryLabel } from '../../data/categories';
import './AuthorPanel.css';

export default function AuthorPanel({ authors, onClose, onOpenPdf }) {
  const [selectedAuthor, setSelectedAuthor] = useState(null);
  const [wikiInfo, setWikiInfo] = useState(null);
  const [papers, setPapers] = useState([]);
  const [openAlexProfile, setOpenAlexProfile] = useState(null);
  const [loading, setLoading] = useState(false);

  // Close when clicking outside panel
  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const selectAuthor = async (author) => {
    setSelectedAuthor(author);
    setLoading(true);
    setWikiInfo(null);
    setPapers([]);
    setOpenAlexProfile(null);

    try {
      // Fetch in parallel
      const [wiki, authorPapers, oaProfile] = await Promise.all([
        getAuthorWikiInfo(author),
        getAuthorPapers(author, 10),
        getAuthorProfile(author)
      ]);
      setWikiInfo(wiki);
      setPapers(authorPapers || []);
      setOpenAlexProfile(oaProfile);
    } catch (err) {
      console.error('Error fetching author info:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleBack = () => {
    setSelectedAuthor(null);
  };

  const formatDate = (dateStr) => {
    try { return new Date(dateStr).toLocaleDateString('es-ES', { year: 'numeric', month: 'short' }); }
    catch { return ''; }
  };

  return (
    <div className="ap-backdrop" onClick={handleBackdropClick}>
      <div className="ap-container">
        {/* Header */}
        <div className="ap-header">
          {selectedAuthor ? (
            <button className="ap-back-btn" onClick={handleBack}>
              <ChevronLeft size={24} />
            </button>
          ) : (
            <div style={{ width: 24 }} /> // spacer
          )}
          
          <h2 className="ap-title">
            {selectedAuthor ? selectedAuthor : 'Autores'}
          </h2>
          
          <button className="ap-close-btn" onClick={onClose}>
            <X size={24} />
          </button>
        </div>

        {/* Content */}
        <div className="ap-content">
          {!selectedAuthor ? (
            // Authors List View
            <div className="ap-authors-list">
              {authors.map((author, idx) => (
                <button 
                  key={idx} 
                  className="ap-author-item"
                  onClick={() => selectAuthor(author)}
                >
                  <div className="ap-author-avatar">
                    {author.charAt(0).toUpperCase()}
                  </div>
                  <span className="ap-author-name">{author}</span>
                </button>
              ))}
            </div>
          ) : (
            // Author Profile View
            <div className="ap-author-profile">
              {loading ? (
                <div className="ap-loading">
                  <Loader2 size={32} className="ap-spinner" />
                  <p>Cargando información...</p>
                </div>
              ) : (
                <>
                  {/* OpenAlex Stats Section */}
                  {openAlexProfile && (
                    <div className="ap-openalex-card">
                      {openAlexProfile.institution && (
                        <div className="ap-oa-institution">
                          <Building2 size={16} /> {openAlexProfile.institution}
                        </div>
                      )}
                      
                      <div className="ap-oa-stats-grid">
                        <div className="ap-oa-stat">
                          <span className="ap-oa-stat-value">{openAlexProfile.h_index}</span>
                          <span className="ap-oa-stat-label">H-Index</span>
                        </div>
                        <div className="ap-oa-stat">
                          <span className="ap-oa-stat-value">{openAlexProfile.works_count}</span>
                          <span className="ap-oa-stat-label">Publicaciones</span>
                        </div>
                        <div className="ap-oa-stat">
                          <span className="ap-oa-stat-value">{openAlexProfile.cited_by_count.toLocaleString()}</span>
                          <span className="ap-oa-stat-label">Citas Totales</span>
                        </div>
                      </div>

                      {openAlexProfile.concepts && openAlexProfile.concepts.length > 0 && (
                        <div className="ap-oa-concepts">
                          <h4 className="ap-oa-concepts-title">
                            <Award size={14} /> Especialidades
                          </h4>
                          <div className="ap-oa-concepts-list">
                            {openAlexProfile.concepts.map((c, i) => (
                              <span key={i} className="ap-oa-concept-tag">{c.display_name}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Wikipedia Section */}
                  {wikiInfo && (
                    <div className="ap-wiki-card">
                      {wikiInfo.thumbnail && (
                        <img src={wikiInfo.thumbnail} alt={wikiInfo.title} className="ap-wiki-img" />
                      )}
                      <div className="ap-wiki-text">
                        <p className="ap-wiki-desc">{wikiInfo.description}</p>
                        <p className="ap-wiki-extract">{wikiInfo.extract}</p>
                        {wikiInfo.pageUrl && (
                          <a href={wikiInfo.pageUrl} target="_blank" rel="noopener noreferrer" className="ap-wiki-link">
                            Leer más en Wikipedia <ExternalLink size={14} />
                          </a>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Papers Section */}
                  <div className="ap-papers-section">
                    <h3 className="ap-papers-title">
                      <BookOpen size={18} /> 
                      Publicaciones recientes
                    </h3>
                    
                    {papers.length > 0 ? (
                      <div className="ap-papers-list">
                        {papers.map(paper => (
                          <div 
                            key={paper.id} 
                            className="ap-paper-card"
                            onClick={() => onOpenPdf(paper)}
                          >
                            <span className="ap-paper-cat">
                              {getCategoryLabel(paper.primaryCategory)}
                            </span>
                            <h4 className="ap-paper-title">{paper.title}</h4>
                            <div className="ap-paper-meta">
                              <span>{paper.authors.slice(0, 2).join(', ')}{paper.authors.length > 2 && ' et al.'}</span>
                              <span>• {formatDate(paper.published)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="ap-no-papers">No se encontraron artículos recientes en arXiv.</p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
