export function GET() {
  return new Response('User-agent: *\nDisallow: /\n', {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

export function HEAD() {
  return new Response(null, { headers: GET().headers });
}
