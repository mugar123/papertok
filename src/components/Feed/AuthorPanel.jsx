import React, { useState, useEffect } from 'react';
import { getAuthorWikiInfo } from '../../services/wikiService';
import { getAuthorPapers } from '../../services/arxivService';
import { getAuthorProfileExact } from '../../services/openAlexService';
import { getSimilarAuthors } from '../../services/semanticScholarService';
import { X, ChevronLeft, ExternalLink, Loader2, BookOpen, Award, Building2, UserPlus, UserCheck, Users } from 'lucide-react';
import { getCategoryLabel } from '../../data/categories';
import { useAuth } from '../../context/AuthContext';
import { motion } from 'framer-motion';
import './AuthorPanel.css';

export default function AuthorPanel({ authors, onClose, onOpenPdf, sourceArxivId = null }) {
  const [selectedAuthor, setSelectedAuthor] = useState(null);
  const [wikiInfo, setWikiInfo] = useState(null);
  const [papers, setPapers] = useState([]);
  const [openAlexProfile, setOpenAlexProfile] = useState(null);
  const [similarAuthors, setSimilarAuthors] = useState([]);
  const [loading, setLoading] = useState(false);
  const { followedAuthors, toggleFollowAuthor } = useAuth();

  const isFollowing = selectedAuthor ? followedAuthors.includes(selectedAuthor) : false;

  const handleToggleFollow = async () => {
    if (!selectedAuthor) return;
    try {
      await toggleFollowAuthor(selectedAuthor);
    } catch (err) {
      console.error(err);
    }
  };

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
      const [wiki, authorPapers, oaProfile, similarAuths] = await Promise.all([
        getAuthorWikiInfo(author),
        getAuthorPapers(author, 10),
        getAuthorProfileExact(author, sourceArxivId),
        getSimilarAuthors(author)
      ]);
      setWikiInfo(wiki);
      setPapers(authorPapers || []);
      setOpenAlexProfile(oaProfile);
      setSimilarAuthors(similarAuths || []);
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
    <motion.div 
      className="ap-backdrop" 
      onClick={handleBackdropClick}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div 
        className="ap-container"
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", bounce: 0, duration: 0.4 }}
      >
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
          
          {selectedAuthor && (
            <button 
              className={`ap-follow-btn ${isFollowing ? 'following' : ''}`}
              onClick={handleToggleFollow}
            >
              {isFollowing ? (
                <><UserCheck size={16} /> Siguiendo</>
              ) : (
                <><UserPlus size={16} /> Seguir</>
              )}
            </button>
          )}
          
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
                  {openAlexProfile && !openAlexProfile.id?.startsWith('stub-') && (
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
                          <span className="ap-oa-stat-value">{openAlexProfile.cited_by_count?.toLocaleString() || 0}</span>
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

                  {/* Similar Authors Section */}
                  {similarAuthors && similarAuthors.length > 0 && (
                    <div className="ap-similar-authors-section" style={{ marginBottom: '20px' }}>
                      <h4 className="ap-similar-authors-title" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '1.05rem', marginBottom: '12px', color: 'var(--text-primary)' }}>
                        <Users size={16} /> Colaboradores Frecuentes
                      </h4>
                      <div className="ap-similar-authors-list" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                        {similarAuthors.map((sim, idx) => (
                          <button 
                            key={idx} 
                            className="ap-similar-author-pill"
                            onClick={() => selectAuthor(sim.name)}
                            style={{
                              display: 'flex', alignItems: 'center', gap: '8px',
                              background: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)',
                              padding: '6px 12px 6px 6px', borderRadius: '20px', color: 'var(--text-primary)',
                              cursor: 'pointer', transition: 'all 0.2s', fontSize: '0.85rem'
                            }}
                          >
                            <div className="ap-similar-avatar" style={{
                              width: '24px', height: '24px', borderRadius: '50%',
                              background: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontWeight: 'bold', fontSize: '0.75rem'
                            }}>
                              {sim.name.charAt(0).toUpperCase()}
                            </div>
                            <span>{sim.name}</span>
                          </button>
                        ))}
                      </div>
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
      </motion.div>
    </motion.div>
  );
}
