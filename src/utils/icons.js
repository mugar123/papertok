import {
  Atom,
  BookOpen,
  Dna,
  Eye,
  Fire,
  Flask,
  Folder,
  Heart,
  Lightbulb,
  Microscope,
  Star,
  Target,
} from '@phosphor-icons/react';

// The keys are the icon names stored on each list in Firestore, so they keep
// the names they were saved under even where the glyph behind them changed
// library (FlaskConical and Flame were Lucide's names).
export const ICONS = {
  Folder, Star, Microscope, FlaskConical: Flask, BookOpen, Target, Lightbulb, Dna, Atom, Flame: Fire, Heart, Eye
};

export const getIcon = (nameOrEmoji) => {
  if (ICONS[nameOrEmoji]) return ICONS[nameOrEmoji];
  
  // Backwards compatibility with emojis already in database
  const emojiMap = {
    '📂': Folder, '⭐': Star, '🔬': Microscope, '🧪': Flask, 
    '📚': BookOpen, '🎯': Target, '💡': Lightbulb, '🧬': Dna, 
    '⚛️': Atom, '🔥': Fire, '❤️': Heart
  };
  return emojiMap[nameOrEmoji] || Folder;
};

export const AVAILABLE_ICONS = ['Folder', 'Star', 'Microscope', 'FlaskConical', 'BookOpen', 'Target', 'Lightbulb', 'Dna', 'Atom', 'Flame'];
