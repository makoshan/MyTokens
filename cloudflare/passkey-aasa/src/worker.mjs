const AASA_PATH = '/.well-known/apple-app-site-association'

function buildAppleAppSiteAssociation(appId) {
  return {
    webcredentials: {
      apps: [appId],
    },
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname !== AASA_PATH) {
      return new Response('Not found', { status: 404 })
    }

    const appId = env.APPLE_APP_ID
    if (!appId) {
      return new Response('APPLE_APP_ID is not configured', { status: 500 })
    }

    return new Response(JSON.stringify(buildAppleAppSiteAssociation(appId)), {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=300',
      },
    })
  },
}
