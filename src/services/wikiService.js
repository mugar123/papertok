export const getAuthorWikiInfo = async (authorName) => {
  if (!authorName) return null;

  try {
    // Wikipedia API for page summaries (English)
    // We replace spaces with underscores for the title
    const title = encodeURIComponent(authorName.trim().replace(/\s+/g, '_'));
    const response = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`);
    
    if (!response.ok) {
      if (response.status === 404) {
        return null; // Author doesn't have a Wikipedia page
      }
      throw new Error(`Wikipedia API error: ${response.status}`);
    }

    const data = await response.json();
    
    // Wikipedia returns type="disambiguation" if multiple people share the name
    if (data.type === 'disambiguation') {
      return null;
    }

    // Validate that the person is actually a researcher/scientist
    // to avoid showing actors/politicians who share the same name.
    const textToCheck = `${data.description || ''} ${data.extract || ''}`.toLowerCase();
    const academicKeywords = [
      'scientist', 'researcher', 'professor', 'academic', 'physicist', 
      'chemist', 'biologist', 'mathematician', 'engineer', 'scholar', 
      'astronomer', 'computer', 'science', 'university', 'institute', 
      'doctor', 'phd', 'inventor', 'author', 'research'
    ];

    const isAcademic = academicKeywords.some(keyword => textToCheck.includes(keyword));
    
    if (!isAcademic) {
      return null; // False positive (e.g., football player with same name)
    }

    return {
      title: data.title,
      description: data.description, // e.g., "American computer scientist"
      extract: data.extract, // Text summary
      thumbnail: data.thumbnail?.source || null, // Image URL if available
      pageUrl: data.content_urls?.desktop?.page || null
    };
  } catch (error) {
    console.error('Error fetching Wikipedia info:', error);
    return null;
  }
};
