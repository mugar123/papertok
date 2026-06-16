import React from 'react';
import { X, FileText, ArrowRight, Share2, Bookmark } from 'lucide-react';
import Latex from 'react-latex-next';
import './PaperDetailsModal.css';

const processLatex = (text) => {
  if (!text) return '';
  let processed = text.replace(/\n+/g, ' ');
  processed = processed.replace(/(^|[^\\])%/g, '$1\\%');
  return processed;
};

export default function PaperDetailsModal({ paper, onClose, onOpenPdf }) {
  if (!paper) return null;

  return (
    <div className="pdm-overlay" onClick={onClose}>
      <div className="pdm-modal" onClick={e => e.stopPropagation()}>
        <button className="pdm-close" onClick={onClose}>
          <X size={24} />
        </button>
        
        <div className="pdm-content custom-scrollbar">
          <div className="pdm-header">
            <span className="pdm-cat">{paper.primaryCategory}</span>
            <span className="pdm-date">{new Date(paper.published).toLocaleDateString()}</span>
          </div>
          
          <h2 className="pdm-title">
            <Latex>{processLatex(paper.title)}</Latex>
          </h2>
          
          <div className="pdm-authors">
            {paper.authors.join(', ')}
          </div>
          
          <div className="pdm-abstract">
            <h3>Resumen</h3>
            <p><Latex>{processLatex(paper.summary)}</Latex></p>
          </div>
          
          {paper.openAlex?.concepts && paper.openAlex.concepts.length > 0 && (
            <div className="pdm-tags">
              {paper.openAlex.concepts.slice(0, 5).map(c => (
                <span key={c.id} className="pdm-tag">{c.display_name}</span>
              ))}
            </div>
          )}
        </div>
        
        <div className="pdm-footer">
          <button className="pdm-action-btn primary" onClick={() => onOpenPdf(paper)}>
            <FileText size={20} />
            Leer PDF
            <ArrowRight size={18} style={{ marginLeft: 'auto' }} />
          </button>
        </div>
      </div>
    </div>
  );
}
