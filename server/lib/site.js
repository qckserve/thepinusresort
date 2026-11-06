// Same contact details the website uses (data/site.json is the single source).
// Imported (not read from disk) so serverless bundlers include it.
import site from '../../data/site.json' with { type: 'json' };

export { site };
