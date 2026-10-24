import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RawResponseInspection } from './RawResponseInspection';

describe('RawResponseInspection', () => {
  it('keeps empty engine responses explicit', () => {
    const markup = renderToStaticMarkup(
      <RawResponseInspection valhallaRoute={null} osrmRoute={null} />,
    );

    expect(markup).toContain('No Valhalla route response yet.');
    expect(markup).toContain('No OSRM route response yet.');
    expect(markup.match(/Empty/g)).toHaveLength(2);
  });

  it('renders both raw response payloads', () => {
    const markup = renderToStaticMarkup(
      <RawResponseInspection
        valhallaRoute={{ trip: { status: 0 } }}
        osrmRoute={{ code: 'Ok' }}
      />,
    );

    expect(markup).toContain('&quot;status&quot;: 0');
    expect(markup).toContain('&quot;code&quot;: &quot;Ok&quot;');
    expect(markup.match(/Available/g)).toHaveLength(2);
  });
});
