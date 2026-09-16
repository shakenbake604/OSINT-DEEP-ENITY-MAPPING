/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * This file defines and runs an MCP (Model Context Protocol) server.
 * The server exposes tools that an AI model (like Gemini) can call to interact
 * with Google Maps functionality. These tools include:
 * - `view_location_google_maps`: To display a specific location.
 * - `directions_on_google_maps`: To get and display directions.
 *
 * When the AI decides to use one of these tools, the MCP server receives the
 * call and then uses the `mapQueryHandler` callback to send the relevant
 * parameters (location, origin/destination) to the frontend
 * (MapApp component in map_app.ts) to update the map display.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {z} from 'zod';

export interface TimelineEvent {
  date: string;
  event: string;
}

export interface Citation {
  source: string;
  link: string;
}

export interface RelationshipNode {
  id: string;
  label: string;
  location: string;
  type: 'person' | 'company' | 'address' | 'ip' | 'dns';
  details: string;
  isSuspicious?: boolean;
  image?: string;
  link?: string;
  timeline?: TimelineEvent[];
  citations?: Citation[];
  openCorpLink?: string;
}

export interface RelationshipEdge {
  from: string;
  to: string;
  label: string;
  description: string;
}

export interface MapParams {
  location?: string;
  origin?: string;
  destination?: string;
  relationships?: {
    nodes: RelationshipNode[];
    edges: RelationshipEdge[];
  };
}

export async function startMcpGoogleMapServer(
  transport: Transport,
  /**
   * Callback function provided by the frontend (index.tsx) to handle map updates.
   * This function is invoked when an AI tool call requires a map interaction,
   * passing the necessary parameters to update the map view (e.g., show location,
   * display directions). It is the bridge between MCP server tool execution and
   * the visual map representation in the MapApp component.
   */
  mapQueryHandler: (params: MapParams) => void,
) {
  // Create an MCP server
  const server = new McpServer({
    name: 'AI Studio Google Map',
    version: '1.0.0',
  });

  server.tool(
    'investigate_entity_relationships',
    'Investigate and visualize complex relationships between people, companies, addresses, IP addresses, and DNS entries. Shows connections based on common attributes, filings, or court documents.',
    {
      query: z.string().describe('The search query or entity to investigate'),
      entities: z.array(z.object({
        id: z.string(),
        label: z.string(),
        location: z.string().describe('A geographical address or city for mapping'),
        type: z.enum(['person', 'company', 'address', 'ip', 'dns']),
        details: z.string().describe('Description of findings/attributes'),
        isSuspicious: z.boolean().optional().describe('Whether this entity is flagged for fraudulent activity'),
        image: z.string().optional().describe('URL to a relevant image if available'),
        link: z.string().optional().describe('URL to verifying documentation'),
        timeline: z.array(z.object({
          date: z.string().describe('Date of the event (e.g. "2023-01-01")'),
          event: z.string().describe('Description of structural changes, agent updates, etc.')
        })).optional().describe('Significant dates in the entity history'),
        citations: z.array(z.object({
          source: z.string().describe('Source name for the information'),
          link: z.string().describe('URL to validate authenticity')
        })).optional().describe('Supporting evidence and verifiable links'),
        openCorpLink: z.string().optional().describe('URL to OpenCorporates entry')
      })).describe('List of discovered entities/nodes'),
      connections: z.array(z.object({
        from: z.string(),
        to: z.string(),
        label: z.string().describe('Relationship type (e.g., "Owner", "Registered Agent")'),
        description: z.string().describe('Detailed attribute match finding')
      })).describe('Connections between the discovered entities')
    },
    async ({query, entities, connections}) => {
      mapQueryHandler({
        relationships: {
          nodes: entities,
          edges: connections
        }
      });
      return {
        content: [{
          type: 'text',
          text: `Visualizing relationship network for: ${query}. Total entities: ${entities.length}, Total connections: ${connections.length}.`
        }],
      };
    },
  );

  server.tool(
    'view_location_google_maps',
    'View a specific query or geographical location and display in the embedded maps interface',
    {query: z.string()},
    async ({query}) => {
      mapQueryHandler({location: query});
      return {
        content: [{type: 'text', text: `Navigating to: ${query}`}],
      };
    },
  );

  server.tool(
    'directions_on_google_maps',
    'Search google maps for directions from origin to destination.',
    {origin: z.string(), destination: z.string()},
    async ({origin, destination}) => {
      mapQueryHandler({origin, destination});
      return {
        content: [
          {type: 'text', text: `Navigating from ${origin} to ${destination}`},
        ],
      };
    },
  );

  await server.connect(transport);
  console.log('server running');
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
