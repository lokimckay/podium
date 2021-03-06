import { EVENT, TOURNAMENT } from "./queries";
import fetch from "isomorphic-unfetch";
import { isEqual, uniqWith } from "lodash";
import { followRedirect } from "../../lib/redirects";

// Parses URL, queries Smashgg API and returns event standings
export async function getEvents({ url, source, players }) {
  const { queryId, isTourny, tournament, tournamentLink } =
    source === "smashgg"
      ? await parseSmashggUrl(url)
      : await parseSmashggUrl(`https://smash.gg/tournament/${url}`);

  const response = await query({
    query: isTourny ? TOURNAMENT(players) : EVENT(players),
    variables: { slug: queryId },
  });
  const result = await response.json();

  if (result.errors)
    return result.errors.map((error) => ({ message: error.message }));

  const events = isTourny
    ? result.data.tournament?.events
    : [result.data.event];
  if (!events)
    return { message: `No events returned by SmashGG for URL: \`${url}\`` };

  return events.map((event) => {
    return reshapeEvent({ ...event, tournament, tournamentLink, players });
  });
}

// Queries smashgg GraphQL API
export function query({ query, variables = {} }) {
  return fetch(process.env.SMASHGG_GRAPHQL_ENDPOINT, {
    body: query(variables),
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SMASHGG_GRAPHQL_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
}

// Extracts player tag and crew from playerName
function parsePlayerName(playerName) {
  if (!playerName) return {};
  const match = playerName.match(/^(?:(?<crew>.+) \| )?(?<tag>.+)$/);
  if (!match) throw `Could not parse player name ${playerName}`;
  const {
    groups: { crew, tag },
  } = match;
  return { crew, tag };
}

// Determines if a smashgg URL is a tournament or event URL and returns the smashgg slug
async function parseSmashggUrl(url) {
  if (!url) throw "No URL defined";
  const finalUrl = await followRedirect(url);
  const match = finalUrl.match(
    /tournament\/(?<tournament>[^\/\s]+)(\/event\/(?<event>[^\/\s]+))?/
  );
  if (!match) throw `Could not parse SmashGG URL \`${finalUrl}\``;

  const {
    groups: { tournament, event },
  } = match;

  const isTourny = !event;
  const queryId = isTourny
    ? tournament
    : `tournament/${tournament}/event/${event}`;

  return {
    isTourny,
    queryId,
    slug: event,
    tournament,
    event,
    tournamentLink: `https://smash.gg/tournament/${tournament}`,
  };
}

// Reshapes smashgg response data to common format
function reshapeEvent(data) {
  const {
    id,
    name,
    slug,
    tournament,
    tournamentLink,
    players: playerSearchTerms,
  } = data;

  const players = new Set();
  const errors = new Set();

  Object.entries(data).forEach(([key, value]) => {
    if (!key.startsWith("entrant_")) return;
    const playerIndex = key.split("entrant_")[1];
    const searchTerm = playerSearchTerms[playerIndex];
    const { players: matchedPlayers, error } = reshapeEntrantMatches({
      searchTerm,
      pageInfo: value.pageInfo,
      matches: value.nodes,
    });

    if (matchedPlayers)
      matchedPlayers.forEach((matchedPlayer) => {
        players.add(matchedPlayer);
      });
    if (error) errors.add(error);
  });

  return {
    id,
    name,
    tournament,
    tournamentLink,
    link: `https://smash.gg/${slug}`,
    slug,
    players: uniqWith(Array.from(players), isEqual),
    errors: Array.from(errors),
  };
}

function reshapeEntrantMatches({ searchTerm, pageInfo, matches }) {
  const tooManyMatches = pageInfo.totalPages > 1;
  if (tooManyMatches) {
    return {
      error: `Found too many players matching ${searchTerm}. Please be more specific`,
    };
  } else if (matches) {
    const players = matches.map((matchedPlayer) => {
      const { name, standing } = matchedPlayer;
      return {
        name,
        ...parsePlayerName(name),
        placement: standing?.placement,
      };
    });

    return { players };
  }

  return {};
}
