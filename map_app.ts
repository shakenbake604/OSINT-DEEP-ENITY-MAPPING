/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * This file defines the main `gdm-map-app` LitElement component.
 * This component is responsible for:
 * - Rendering the user interface, including the Google Photorealistic 3D Map,
 *   chat messages area, and user input field.
 * - Managing the state of the chat (e.g., idle, generating, thinking).
 * - Handling user input and sending messages to the Gemini AI model.
 * - Processing responses from the AI, including displaying text and handling
 *   function calls (tool usage) related to map interactions.
 * - Integrating with the Google Maps JavaScript API to load and control the map,
 *   display markers, polylines for routes, and geocode locations.
 * - Providing the `handleMapQuery` method, which is called by the MCP server
 *   (via index.tsx) to update the map based on AI tool invocations.
 */

// Google Maps JS API Loader: Used to load the Google Maps JavaScript API.
import {Loader} from '@googlemaps/js-api-loader';
import hljs from 'highlight.js';
import {html, LitElement, PropertyValueMap} from 'lit';
import {customElement, query, state} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';
import {Marked} from 'marked';
import {markedHighlight} from 'marked-highlight';
import { googleSignIn, initAuth, getAccessToken, logout } from './auth';

import {MapParams, RelationshipEdge, RelationshipNode} from './mcp_maps_server';

/** Markdown formatting function with syntax hilighting */
export const marked = new Marked(
  markedHighlight({
    async: true,
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang, info) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, {language}).value;
    },
  }),
);

const ICON_BUSY = html`<svg
  class="rotating"
  xmlns="http://www.w3.org/2000/svg"
  height="24px"
  viewBox="0 -960 960 960"
  width="24px"
  fill="currentColor">
  <path
    d="M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 31.5-155.5t86-127Q252-817 325-848.5T480-880q17 0 28.5 11.5T520-840q0 17-11.5 28.5T480-800q-133 0-226.5 93.5T160-480q0 133 93.5 226.5T480-160q133 0 226.5-93.5T800-480q0-17 11.5-28.5T840-520q17 0 28.5 11.5T880-480q0 82-31.5 155t-86 127.5q-54.5 54.5-127 86T480-80Z" />
</svg>`;

/**
 * Chat state enum to manage the current state of the chat interface.
 */
export enum ChatState {
  IDLE,
  GENERATING,
  THINKING,
  EXECUTING,
}

/**
 * Chat tab enum to manage the current selected tab in the chat interface.
 */
enum ChatTab {
  GEMINI,
  DATABASE,
}

/**
 * Chat role enum to manage the current role of the message.
 */
export enum ChatRole {
  USER,
  ASSISTANT,
  SYSTEM,
}

// Google Maps API Key: Replace with your actual Google Maps API key.
// This key is essential for loading and using Google Maps services.
// Ensure this key is configured with access to the "Maps JavaScript API",
// "Geocoding API", and the "Directions API".
const USER_PROVIDED_GOOGLE_MAPS_API_KEY: string =
  'AIzaSyAJPTwj4S8isr4b-3NtqVSxk450IAS1lOQ'; // <-- REPLACE THIS WITH YOUR ACTUAL API KEY

const EXAMPLE_PROMPTS = [
  "Show me directions from Tokyo Tower to Shibuya Crossing.",
  "Can you show me a beautiful beach?",
  "Show me San Francisco",
  "Give me directions from the Eiffel Tower to the Louvre Museum.",
  "Where is a place with a tilted tower?",
  "Can you show me Diamond Head in Hawaii?",
  "Let's go to Venice, Italy.",
  "Take me to the northernmost capital city in the world",
  "What's the way from Buckingham Palace to the Tower of London?",
  "How about the southernmost permanently inhabited settlement? What's it called and where is it?",
  "Let's jump to Machu Picchu in Peru",
  "Can you show me the Three Gorges Dam in China?",
  "Can you find a town or city with an unusual name and show it to me?",
  "How do I get from Times Square, New York to Central Park?",
  "Show me the route from the Golden Gate Bridge to Alcatraz Island.",
  "Investigate the network between 'John Smith' at 450 Sunset Blvd, LA and 'Acme Shell Corp' in Miami. Check for common IP addresses.",
  "Map the relationship between the registered agents at address 123 Main St, New Jersey and 555 Palm Dr, Florida.",
  "Show me the entity network for 'Global Logistics Ltd' and connect any suspicious filing links discovered in Delaware and California.",
];

/**
 * MapApp component for Photorealistic 3D Maps.
 */
@customElement('gdm-map-app')
export class MapApp extends LitElement {
  @query('#anchor') anchor?: HTMLDivElement;
  // Google Maps: Reference to the <gmp-map-3d> DOM element where the map is rendered.
  @query('#mapContainer') mapContainerElement?: HTMLElement; // Will be <gmp-map-3d>
  @query('#messageInput') messageInputElement?: HTMLInputElement;
  @query('#mapTooltip') mapTooltipElement?: HTMLElement;

  @state() chatState = ChatState.IDLE;
  @state() isRunning = true;
  @state() selectedChatTab = ChatTab.GEMINI;
  @state() inputMessage = '';
  @state() messages: HTMLElement[] = [];
  @state() mapInitialized = false;
  @state() mapError = '';
  @state() isGoogleSignedIn = false;

  // Google Maps: Instance of the Google Maps 3D map.
  private map?: any;
  // Google Maps: Instance of the Google Maps Geocoding service.
  private geocoder?: any;
  // Google Maps: Instance of the current map marker (Marker3DElement).
  private marker?: any;

  // Google Maps: References to 3D map element constructors.
  private Map3DElement?: any;
  private Marker3DElement?: any;
  private Polyline3DElement?: any;

  // Google Maps: Instance of the Google Maps Directions service.
  private directionsService?: any;
  // Google Maps: Instance of the current route polyline.
  private routePolyline?: any;
  // Google Maps: Markers for origin and destination of a route.
  private originMarker?: any;
  private destinationMarker?: any;

  // Relationship visualization state
  private relationshipMarkers: any[] = [];
  private relationshipLines: any[] = [];
  
  // Consolidated investigative data
  @state() private allNodes: RelationshipNode[] = [];
  @state() private allEdges: RelationshipEdge[] = [];

  sendMessageHandler?: CallableFunction;

  constructor() {
    super();
    // Set initial input from a random example prompt
    this.setNewRandomPrompt();
  }

  createRenderRoot() {
    return this;
  }

  protected firstUpdated(
    _changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>,
  ): void {
    initAuth(
      (user, token) => {
        this.isGoogleSignedIn = true;
      },
      () => {
        this.isGoogleSignedIn = false;
      }
    );
    // Google Maps: Load the map when the component is first updated.
    this.loadMap();
  }

  private async _handleGoogleSignIn() {
    try {
      const result = await googleSignIn();
      if (result) {
        this.isGoogleSignedIn = true;
      }
    } catch (e) {
      console.error('Google Sign-in failed', e);
      alert('Google Sign-in failed. This may be due to missing configuration.');
    }
  }

  private async _saveToDrive() {
    if (!this.isGoogleSignedIn) {
      await this._handleGoogleSignIn();
    }
    const token = await getAccessToken();
    if (!token) return;

    try {
      const data = {
        nodes: this.allNodes,
        edges: this.allEdges,
        exportedAt: new Date().toISOString()
      };
      
      const fileMetadata = {
        name: `investigation_graph_${new Date().toISOString().split('T')[0]}.json`,
        mimeType: 'application/json'
      };

      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(fileMetadata)], { type: 'application/json' }));
      form.append('file', new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));

      const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`
        },
        body: form
      });
      
      const result = await res.json();
      if (result.id) {
        alert('Successfully saved to Google Drive!');
      } else {
        throw new Error('Upload failed');
      }
    } catch (error) {
      console.error('Failed to save to Drive', error);
      alert('Failed to save to Google Drive.');
    }
  }

  /**
   * Sets the input message to a new random prompt from EXAMPLE_PROMPTS.
   */
  private setNewRandomPrompt() {
    if (EXAMPLE_PROMPTS.length > 0) {
      this.inputMessage =
        EXAMPLE_PROMPTS[Math.floor(Math.random() * EXAMPLE_PROMPTS.length)];
    }
  }

  /**
   * Google Maps: Loads the Google Maps JavaScript API using the JS API Loader.
   * It initializes necessary map services like Geocoding and Directions,
   * and imports 3D map elements (Map3DElement, Marker3DElement, Polyline3DElement).
   * Handles API key validation and error reporting.
   */
  async loadMap() {
    const isApiKeyPlaceholder =
      USER_PROVIDED_GOOGLE_MAPS_API_KEY ===
        'YOUR_ACTUAL_GOOGLE_MAPS_API_KEY_REPLACE_ME' ||
      USER_PROVIDED_GOOGLE_MAPS_API_KEY === '';

    if (isApiKeyPlaceholder) {
      this.mapError = `Google Maps API Key is not configured correctly.
Please edit the map_app.ts file and replace the placeholder value for
USER_PROVIDED_GOOGLE_MAPS_API_KEY with your actual API key.
You can find this constant near the top of the map_app.ts file.`;
      console.error(this.mapError);
      this.requestUpdate();
      return;
    }

    const loader = new Loader({
      apiKey: USER_PROVIDED_GOOGLE_MAPS_API_KEY,
      version: 'beta', // Using 'beta' for Photorealistic 3D Maps features
      libraries: ['geocoding', 'routes', 'geometry'], // Request necessary libraries
    });

    try {
      await loader.load();
      // Google Maps: Import 3D map specific library elements.
      const maps3dLibrary = await (window as any).google.maps.importLibrary(
        'maps3d',
      );
      this.Map3DElement = maps3dLibrary.Map3DElement;
      this.Marker3DElement = maps3dLibrary.Marker3DElement;
      this.Polyline3DElement = maps3dLibrary.Polyline3DElement;

      if ((window as any).google && (window as any).google.maps) {
        // Google Maps: Initialize the DirectionsService.
        this.directionsService = new (
          window as any
        ).google.maps.DirectionsService();
      } else {
        console.error('DirectionsService not loaded.');
      }

      // Google Maps: Initialize the map itself.
      this.initializeMap();
      this.mapInitialized = true;
      this.mapError = '';
    } catch (error) {
      console.error('Error loading Google Maps API:', error);
      this.mapError =
        'Could not load Google Maps. Check console for details and ensure API key is correct. If using 3D features, ensure any necessary Map ID is correctly configured if required programmatically.';
      this.mapInitialized = false;
    }
    this.requestUpdate();
  }

  /**
   * Google Maps: Initializes the map instance and the Geocoder service.
   * This is called after the Google Maps API has been successfully loaded.
   */
  initializeMap() {
    if (!this.mapContainerElement || !this.Map3DElement) {
      console.error('Map container or Map3DElement class not ready.');
      return;
    }
    // Google Maps: Assign the <gmp-map-3d> element to the map property.
    this.map = this.mapContainerElement;
    if ((window as any).google && (window as any).google.maps) {
      // Google Maps: Initialize the Geocoder.
      this.geocoder = new (window as any).google.maps.Geocoder();
    } else {
      console.error('Geocoder not loaded.');
    }
  }

  setChatState(state: ChatState) {
    this.chatState = state;
  }

  /**
   * Google Maps: Clears existing map elements like markers and polylines
   * before adding new ones. This ensures the map doesn't get cluttered with
   * old search results or routes.
   */
  private _clearMapElements() {
    if (this.marker) {
      this.marker.remove();
      this.marker = undefined;
    }
    if (this.routePolyline) {
      this.routePolyline.remove();
      this.routePolyline = undefined;
    }
    if (this.originMarker) {
      this.originMarker.remove();
      this.originMarker = undefined;
    }
    if (this.destinationMarker) {
      this.destinationMarker.remove();
      this.destinationMarker = undefined;
    }
    this.relationshipMarkers.forEach((m) => m.remove());
    this.relationshipMarkers = [];
    this.relationshipLines.forEach((l) => l.remove());
    this.relationshipLines = [];
    this.mapTooltipElement?.classList.add('hidden');
  }

  /**
   * Google Maps: Handles viewing a specific location on the map.
   * It uses the Geocoding service to find coordinates for the `locationQuery`,
   * then flies the camera to that location and places a 3D marker.
   * @param locationQuery The string query for the location (e.g., "Eiffel Tower").
   */
  private async _handleViewLocation(locationQuery: string) {
    if (
      !this.mapInitialized ||
      !this.map ||
      !this.geocoder ||
      !this.Marker3DElement
    ) {
      if (!this.mapError) {
        const {textElement} = this.addMessage('error', 'Processing error...');
        textElement.innerHTML = await marked.parse(
          'Map is not ready to display locations. Please check configuration.',
        );
      }
      console.warn(
        'Map not initialized, geocoder or Marker3DElement not available, cannot render query.',
      );
      return;
    }
    this._clearMapElements(); // Google Maps: Clear previous elements.

    // Google Maps: Use Geocoding service to find the location.
    this.geocoder.geocode(
      {address: locationQuery},
      async (results: any, status: string) => {
        if (status === 'OK' && results && results[0] && this.map) {
          const location = results[0].geometry.location;

          // Google Maps: Define camera options and fly to the location.
          const cameraOptions = {
            center: {lat: location.lat(), lng: location.lng(), altitude: 0},
            heading: 0,
            tilt: 67.5,
            range: 2000, // Distance from the target in meters
          };
          (this.map as any).flyCameraTo({
            endCamera: cameraOptions,
            durationMillis: 1500,
          });

          // Google Maps: Create and add a 3D marker to the map.
          this.marker = new this.Marker3DElement();
          this.marker.position = {
            lat: location.lat(),
            lng: location.lng(),
            altitude: 0,
          };
          const label =
            locationQuery.length > 30
              ? locationQuery.substring(0, 27) + '...'
              : locationQuery;
          this.marker.label = label;
          (this.map as any).appendChild(this.marker);
        } else {
          console.error(
            `Geocode was not successful for "${locationQuery}". Reason: ${status}`,
          );
          const rawErrorMessage = `Could not find location: ${locationQuery}. Reason: ${status}`;
          const {textElement} = this.addMessage('error', 'Processing error...');
          textElement.innerHTML = await marked.parse(rawErrorMessage);
        }
      },
    );
  }

  /**
   * Google Maps: Handles displaying directions between an origin and destination.
   * It uses the DirectionsService to calculate the route, then draws a 3D polyline
   * for the route and places 3D markers at the origin and destination.
   * The camera is adjusted to fit the entire route.
   * @param originQuery The starting point for directions.
   * @param destinationQuery The ending point for directions.
   */
  private async _handleDirections(
    originQuery: string,
    destinationQuery: string,
  ) {
    if (
      !this.mapInitialized ||
      !this.map ||
      !this.directionsService ||
      !this.Marker3DElement ||
      !this.Polyline3DElement
    ) {
      if (!this.mapError) {
        const {textElement} = this.addMessage('error', 'Processing error...');
        textElement.innerHTML = await marked.parse(
          'Map is not ready for directions. Please check configuration.',
        );
      }
      console.warn(
        'Map not initialized or DirectionsService/3D elements not available, cannot render directions.',
      );
      return;
    }
    this._clearMapElements(); // Google Maps: Clear previous elements.

    // Google Maps: Use DirectionsService to get the route.
    this.directionsService.route(
      {
        origin: originQuery,
        destination: destinationQuery,
        travelMode: (window as any).google.maps.TravelMode.DRIVING,
      },
      async (response: any, status: string) => {
        if (
          status === 'OK' &&
          response &&
          response.routes &&
          response.routes.length > 0
        ) {
          const route = response.routes[0];

          // Google Maps: Draw the route polyline using Polyline3DElement.
          if (route.overview_path && this.Polyline3DElement) {
            const pathCoordinates = route.overview_path.map((p: any) => ({
              lat: p.lat(),
              lng: p.lng(),
              altitude: 5,
            })); // Add slight altitude
            this.routePolyline = new this.Polyline3DElement();
            this.routePolyline.coordinates = pathCoordinates;
            this.routePolyline.strokeColor = 'blue';
            this.routePolyline.strokeWidth = 10;
            (this.map as any).appendChild(this.routePolyline);
          }

          // Google Maps: Add marker for the origin.
          if (
            route.legs &&
            route.legs[0] &&
            route.legs[0].start_location &&
            this.Marker3DElement
          ) {
            const originLocation = route.legs[0].start_location;
            this.originMarker = new this.Marker3DElement();
            this.originMarker.position = {
              lat: originLocation.lat(),
              lng: originLocation.lng(),
              altitude: 0,
            };
            this.originMarker.label = 'Origin';
            this.originMarker.style = {
              color: {r: 0, g: 128, b: 0, a: 1}, // Green
            };
            (this.map as any).appendChild(this.originMarker);
          }

          // Google Maps: Add marker for the destination.
          if (
            route.legs &&
            route.legs[0] &&
            route.legs[0].end_location &&
            this.Marker3DElement
          ) {
            const destinationLocation = route.legs[0].end_location;
            this.destinationMarker = new this.Marker3DElement();
            this.destinationMarker.position = {
              lat: destinationLocation.lat(),
              lng: destinationLocation.lng(),
              altitude: 0,
            };
            this.destinationMarker.label = 'Destination';
            this.destinationMarker.style = {
              color: {r: 255, g: 0, b: 0, a: 1}, // Red
            };
            (this.map as any).appendChild(this.destinationMarker);
          }

          // Google Maps: Adjust camera to fit the route bounds.
          if (route.bounds) {
            const bounds = route.bounds;
            const center = bounds.getCenter();
            let range = 10000; // Default range

            // Calculate a more appropriate range based on the route's diagonal distance
            if (
              (window as any).google.maps.geometry &&
              (window as any).google.maps.geometry.spherical
            ) {
              const spherical = (window as any).google.maps.geometry.spherical;
              const ne = bounds.getNorthEast();
              const sw = bounds.getSouthWest();
              const diagonalDistance = spherical.computeDistanceBetween(ne, sw);
              range = diagonalDistance * 1.7; // Multiplier to ensure bounds are visible
            } else {
              console.warn(
                'google.maps.geometry.spherical not available for range calculation. Using fallback range.',
              );
            }

            range = Math.max(range, 2000); // Ensure a minimum sensible range

            const cameraOptions = {
              center: {lat: center.lat(), lng: center.lng(), altitude: 0},
              heading: 0,
              tilt: 45, // Tilt for better 3D perspective of the route
              range: range,
            };
            (this.map as any).flyCameraTo({
              endCamera: cameraOptions,
              durationMillis: 2000,
            });
          }
        } else {
          console.error(
            `Directions request failed. Origin: "${originQuery}", Destination: "${destinationQuery}". Status: ${status}. Response:`,
            response,
          );
          const rawErrorMessage = `Could not get directions from "${originQuery}" to "${destinationQuery}". Reason: ${status}`;
          const {textElement} = this.addMessage('error', 'Processing error...');
          textElement.innerHTML = await marked.parse(rawErrorMessage);
        }
      },
    );
  }

  /**
   * Google Maps: This function is the primary interface for the MCP server (via index.tsx)
   * to trigger updates on the Google Map. When the AI model uses a map-related tool
   * (e.g., view location, get directions), the MCP server processes this request
   * and calls this function with the appropriate parameters.
   *
   * Based on the `params` received, this function will:
   * - If `params.location` is present, call `_handleViewLocation` to show a specific place.
   * - If `params.origin` and `params.destination` are present, call `_handleDirections`
   *   to display a route.
   * - If only `params.destination` is present (as a fallback), it will treat it as a location to view.
   *
   * This mechanism allows the AI's tool usage to be directly reflected on the map UI.
   * @param params An object containing parameters for the map query, like
   *               `location`, `origin`, or `destination`.
   */
  async handleMapQuery(params: MapParams) {
    if (params.relationships) {
      this._handleRelationships(params.relationships);
    } else if (params.location) {
      this._handleViewLocation(params.location);
    } else if (params.origin && params.destination) {
      this._handleDirections(params.origin, params.destination);
    } else if (params.destination) {
      // Fallback if only destination is provided, treat as viewing a location
      this._handleViewLocation(params.destination);
    }
  }

  /**
   * Visualizes a network of entity relationships.
   * Geocodes nodes, draws them, and draws connections.
   * Then performs a flyover of the entire network.
   */
  private async _handleRelationships(relationships: {
    nodes: RelationshipNode[];
    edges: RelationshipEdge[];
  }) {
    if (!this.mapInitialized || !this.map || !this.geocoder) {
      console.error('Map not initialized for relationship investigation.');
      return;
    }

    // 1. Clear existing map elements
    this._clearMapElements();

    // Consolidate nodes and edges for the database
    const newNodeIds = new Set(relationships.nodes.map(n => n.id));
    this.allNodes = [
      ...this.allNodes.filter(n => !newNodeIds.has(n.id)),
      ...relationships.nodes
    ];
    
    const newEdgeKeys = new Set(relationships.edges.map(e => `${e.from}-${e.to}-${e.label}`));
    this.allEdges = [
      ...this.allEdges.filter(e => !newEdgeKeys.has(`${e.from}-${e.to}-${e.label}`)),
      ...relationships.edges
    ];

    const nodePositions = new Map<string, any>();
    const markers: any[] = [];
    const geocodedNodes: Array<{node: RelationshipNode; pos: any}> = [];

    // 2. Geocode and collect positions
    for (const node of relationships.nodes) {
      try {
        const results = await this._geocodeQuery(node.location);
        if (results && results.length > 0) {
          const latLng = results[0].geometry.location;
          const pos = {lat: latLng.lat(), lng: latLng.lng(), altitude: 10};
          geocodedNodes.push({node, pos});
          nodePositions.set(node.id, pos);
        }
      } catch (e) {
        console.error(`Failed to geocode node: ${node.label}`, e);
      }
    }

    // 3. Simple clustering: Group by lat/lng rounded to 5 decimal places
    const clusters = new Map<string, Array<{node: RelationshipNode; pos: any}>>();
    for (const item of geocodedNodes) {
      const key = `${item.pos.lat.toFixed(5)}_${item.pos.lng.toFixed(5)}`;
      if (!clusters.has(key)) {
        clusters.set(key, []);
      }
      clusters.get(key)!.push(item);
    }

    // 4. Create markers (Cluster or individual)
    for (const groupedItems of clusters.values()) {
      const firstItem = groupedItems[0];
      const pos = firstItem.pos;

      if (this.Marker3DElement) {
        if (groupedItems.length > 1) {
          // Cluster logic: Group markers together
          const clusterMarker = new this.Marker3DElement();
          clusterMarker.position = pos;
          clusterMarker.label = `Cluster: ${groupedItems.length} Entities`;
          clusterMarker.style = {color: {r: 255, g: 140, b: 0, a: 1}}; // Dark orange

          // Hover effect for cluster (shows count)
          clusterMarker.addEventListener('pointerenter', (e: any) => {
            if (this.mapTooltipElement) {
              this.mapTooltipElement.textContent = `Cluster: ${groupedItems.length} Entities\nLocation: ${firstItem.node.location}`;
              this.mapTooltipElement.classList.remove('hidden');
              this.mapTooltipElement.style.left = `${e.clientX}px`;
              this.mapTooltipElement.style.top = `${e.clientY}px`;
            }
          });

          clusterMarker.addEventListener('pointerleave', () => {
            this.mapTooltipElement?.classList.add('hidden');
          });

          clusterMarker.addEventListener('pointermove', (e: any) => {
            if (this.mapTooltipElement) {
              this.mapTooltipElement.style.left = `${e.clientX}px`;
              this.mapTooltipElement.style.top = `${e.clientY}px`;
            }
          });

          // Expand on click: zoom in and show individual markers
          clusterMarker.addEventListener('gmp-click', () => {
            // 1. Zoom in effectively
            (this.map as any).flyCameraTo({
              endCamera: {
                center: {lat: pos.lat, lng: pos.lng, altitude: 0},
                tilt: 45,
                range: 1000,
                heading: 0,
              },
              durationMillis: 1500,
            });

            // 2. Hide cluster and reveal individuals
            clusterMarker.remove();
            
            groupedItems.forEach((item, idx) => {
               // Add a tiny jitter so they don't overlap perfectly
               const jitteredPos = this._jitterPosition(item.pos, idx, groupedItems.length);
               const indMarker = this._setupIndividualMarker(item.node, jitteredPos);
               if (indMarker) {
                 (this.map as any).appendChild(indMarker);
                 this.relationshipMarkers.push(indMarker);
               }
            });
          });

          (this.map as any).appendChild(clusterMarker);
          markers.push(clusterMarker);
          this.relationshipMarkers.push(clusterMarker);

          // Log cluster to chat summary
          this.addMessage(
            'assistant',
            `### 🏢 Cluster Detected at ${firstItem.node.location}\nFound ${groupedItems.length} entities at this location. Click the cluster marker on the map to expand the view.`,
          );
        } else {
          // Individual marker logic
          const node = firstItem.node;
          const marker = this._setupIndividualMarker(node, pos);
          if (marker) {
            (this.map as any).appendChild(marker);
            markers.push(marker);
            this.relationshipMarkers.push(marker);
          }
        }

        // Always log individual details to chat for consistency
        for (const item of groupedItems) {
          const node = item.node;
          const {textElement} = this.addMessage(
            'assistant',
            `${node.isSuspicious ? '### 🚩 SUSPICIOUS ACTIVITY DETECTED\n\n' : ''}**Entity: ${node.label}**\nType: ${node.type} | Location: ${node.location}\n\n${node.details}`,
          );
          textElement.classList.add('investigative-log');
          if (node.isSuspicious) textElement.classList.add('suspicious-log');
          
          let extras = '';
          if (node.openCorpLink) extras += `\n\n[OpenCorporates Listing](${node.openCorpLink})`;
          
          if (node.timeline && node.timeline.length > 0) {
            extras += '\n\n**Timeline of Events**:\n';
            node.timeline.forEach(event => {
              extras += `- **${event.date}**: ${event.event}\n`;
            });
          }

          if (node.citations && node.citations.length > 0) {
            extras += '\n\n**Citations & Evidence**:\n';
            node.citations.forEach(cit => {
              extras += `- [${cit.source}](${cit.link})\n`;
            });
          }

          if (node.image) extras += `\n\n![Image](${node.image})`;
          if (node.link) extras += `\n\n[Verify Documentation](${node.link})`;
          
          if (extras) textElement.innerHTML += await marked.parse(extras);
        }
      }
    }

    // 3. Draw relationship lines (edges)
    if (this.Polyline3DElement) {
      for (const edge of relationships.edges) {
        const fromPos = nodePositions.get(edge.from);
        const toPos = nodePositions.get(edge.to);

        if (fromPos && toPos) {
          const line = new this.Polyline3DElement();
          line.coordinates = [fromPos, toPos];
          line.strokeColor = 'rgba(255, 255, 255, 0.8)';
          line.strokeWidth = 6;
          (this.map as any).appendChild(line);
          this.relationshipLines.push(line);

          // Connection logic in chat
          const fromNode = relationships.nodes.find((n) => n.id === edge.from);
          const toNode = relationships.nodes.find((n) => n.id === edge.to);
          const {textElement} = this.addMessage(
            'assistant',
            `**Connection**: ${edge.label}\nLink: ${fromNode?.label} ↔ ${toNode?.label}\n\n*${edge.description}*`,
          );
          textElement.classList.add('investigative-log', 'connection-log');
        }
      }
    }

    // 4. Perform Animated Flyover
    if (markers.length > 0) {
      const bounds = new (window as any).google.maps.LatLngBounds();
      nodePositions.forEach((pos) => bounds.extend({lat: pos.lat, lng: pos.lng}));
      const center = bounds.getCenter();

      // Zoom out to see the network overview first
      await (this.map as any).flyCameraTo({
        endCamera: {
          center: {lat: center.lat(), lng: center.lng(), altitude: 0},
          range: 8000000, // Zoom out to continental/globe view
          tilt: 0,
          heading: 0,
        },
        durationMillis: 2000,
      });

      // Flyover each node
      for (const marker of markers) {
        await new Promise((r) => setTimeout(r, 1500));
        await (this.map as any).flyCameraTo({
          endCamera: {
            center: marker.position,
            tilt: 45,
            range: 3000,
            heading: Math.random() * 360,
          },
          durationMillis: 2500,
        });
      }

      // Finish with overview
      await (this.map as any).flyCameraTo({
        endCamera: {
          center: {lat: center.lat(), lng: center.lng(), altitude: 0},
          range: 4000000,
          tilt: 30,
          heading: 0,
        },
        durationMillis: 3000,
      });
    }
  }

  /**
   * Helper to wrap the Google Maps Geocoder in a Promise.
   */
  private _geocodeQuery(query: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.geocoder) {
        reject(new Error('Geocoder not initialized'));
        return;
      }
      this.geocoder.geocode({address: query}, (results: any, status: string) => {
        if (status === 'OK') {
          resolve(results);
        } else {
          reject(new Error(`Geocoding failed: ${status}`));
        }
      });
    });
  }

  /**
   * Helper to add small jitter to coordinates to separate overlapping markers.
   */
  private _jitterPosition(pos: {lat: number, lng: number, altitude: number}, index: number, total: number) {
    if (total <= 1) return pos;
    const angle = (index / total) * 2 * Math.PI;
    const radius = 0.0001; // Roughly 10 meters 
    return {
      lat: pos.lat + radius * Math.cos(angle),
      lng: pos.lng + radius * Math.sin(angle),
      altitude: pos.altitude
    };
  }

  /**
   * Internal helper to create and configure an individual marker for an entity.
   */
  private _setupIndividualMarker(node: RelationshipNode, pos: {lat: number, lng: number, altitude: number}) {
    if (!this.Marker3DElement) return null;
    
    const marker = new this.Marker3DElement();
    marker.position = pos;
    marker.label = `${node.label} (${node.type})${node.isSuspicious ? ' [!] ' : ''}`;

    // Hover effect for individual marker
    marker.addEventListener('pointerenter', (e: any) => {
      if (this.mapTooltipElement) {
        this.mapTooltipElement.textContent = `${node.label} (${node.type})\nLocation: ${node.location}`;
        this.mapTooltipElement.classList.remove('hidden');
        this.mapTooltipElement.style.left = `${e.clientX}px`;
        this.mapTooltipElement.style.top = `${e.clientY}px`;
      }
    });

    marker.addEventListener('pointerleave', () => {
      this.mapTooltipElement?.classList.add('hidden');
    });

    marker.addEventListener('pointermove', (e: any) => {
      if (this.mapTooltipElement) {
        this.mapTooltipElement.style.left = `${e.clientX}px`;
        this.mapTooltipElement.style.top = `${e.clientY}px`;
      }
    });

    // Click effect for individual marker: show details in chat
    marker.addEventListener('gmp-click', async () => {
      this.selectedChatTab = ChatTab.GEMINI;
      const {textElement} = this.addMessage(
        'assistant',
        `### 🔍 Detailed View: ${node.label}\n\n${node.isSuspicious ? '🚩 **SUSPICIOUS ACTIVITY DETECTED**\n\n' : ''}**Type**: ${node.type}\n**Location**: ${node.location}\n\n**Forensic Summary**:\n${node.details}`,
      );
      textElement.classList.add('investigative-log');
      if (node.isSuspicious) textElement.classList.add('suspicious-log');
      
      let extras = '';
      if (node.openCorpLink) extras += `\n\n[OpenCorporates Listing](${node.openCorpLink})`;
      
      if (node.timeline && node.timeline.length > 0) {
        extras += '\n\n**Timeline of Events**:\n';
        node.timeline.forEach(event => {
          extras += `- **${event.date}**: ${event.event}\n`;
        });
      }

      if (node.citations && node.citations.length > 0) {
        extras += '\n\n**Citations & Evidence**:\n';
        node.citations.forEach(cit => {
          extras += `- [${cit.source}](${cit.link})\n`;
        });
      }

      if (node.image) extras += `\n\n![Image](${node.image})`;
      if (node.link) extras += `\n\n[Verify Documentation](${node.link})`;
      
      if (extras) textElement.innerHTML += await marked.parse(extras);
      
      this.scrollToTheEnd();
    });

    // Color code by type
    let color = {r: 255, g: 255, b: 255, a: 1};
    if (node.isSuspicious) {
      color = {r: 139, g: 0, b: 0, a: 1}; // Dark Red
    } else {
      switch (node.type) {
        case 'person': color = {r: 52, g: 168, b: 83, a: 1}; break;
        case 'company': color = {r: 66, g: 133, b: 244, a: 1}; break;
        case 'address': color = {r: 251, g: 188, b: 5, a: 1}; break;
        case 'ip':
        case 'dns': color = {r: 234, g: 67, b: 53, a: 1}; break;
      }
    }
    marker.style = {color};
    return marker;
  }

  setInputField(message: string) {
    this.inputMessage = message.trim();
  }

  addMessage(role: string, message: string) {
    const div = document.createElement('div');
    div.classList.add('turn');
    div.classList.add(`role-${role.trim()}`);
    div.setAttribute('aria-live', 'polite');

    const thinkingDetails = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Thinking process';
    thinkingDetails.classList.add('thinking');
    thinkingDetails.setAttribute('aria-label', 'Model thinking process');
    const thinkingElement = document.createElement('div');
    thinkingDetails.append(summary);
    thinkingDetails.append(thinkingElement);
    div.append(thinkingDetails);

    const textElement = document.createElement('div');
    textElement.className = 'text';
    textElement.innerHTML = message;
    div.append(textElement);

    this.messages = [...this.messages, div];
    this.scrollToTheEnd();
    return {
      thinkingContainer: thinkingDetails,
      thinkingElement: thinkingElement,
      textElement: textElement,
    };
  }

  scrollToTheEnd() {
    if (!this.anchor) return;
    this.anchor.scrollIntoView({
      behavior: 'smooth',
      block: 'end',
    });
  }

  async sendMessageAction(message?: string, role?: string) {
    if (this.chatState !== ChatState.IDLE) return;

    let msg = '';
    let usedComponentInput = false; // Flag to track if component's input was used

    if (message) {
      // Message is provided programmatically
      msg = message.trim();
    } else {
      // Message from the UI input field
      msg = this.inputMessage.trim();
      // Clear the input field state only if we are using its content
      // and there was actual content to send.
      if (msg.length > 0) {
        this.inputMessage = '';
        usedComponentInput = true;
      } else if (
        this.inputMessage.trim().length === 0 &&
        this.inputMessage.length > 0
      ) {
        // If inputMessage contained only whitespace, clear it and mark as used.
        this.inputMessage = '';
        usedComponentInput = true;
      }
    }

    if (msg.length === 0) {
      // If the final message to send is empty (e.g., user entered only spaces, or an empty programmatic message)
      // set a new random prompt if the component's input was cleared.
      if (usedComponentInput) {
        this.setNewRandomPrompt();
      }
      return;
    }

    const msgRole = role ? role.toLowerCase() : 'user';

    // Add user's message to the chat display
    if (msgRole === 'user' && msg) {
      const {textElement} = this.addMessage(msgRole, '...');
      textElement.innerHTML = await marked.parse(msg);
    }

    // Send the message via the handler (to AI)
    if (this.sendMessageHandler) {
      await this.sendMessageHandler(msg, msgRole);
    }

    // If the component's main input field was used and cleared, set a new random prompt.
    if (usedComponentInput) {
      this.setNewRandomPrompt();
    }
  }

  private async inputKeyDownAction(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.sendMessageAction();
    }
  }

  private _exportToCSV() {
    const headers = ['ID', 'Label', 'Type', 'Location', 'Is Suspicious', 'Details', 'OpenCorp Link'];
    const rows = this.allNodes.map(n => [
      n.id,
      `"${n.label.replace(/"/g, '""')}"`,
      n.type,
      `"${n.location.replace(/"/g, '""')}"`,
      n.isSuspicious ? 'YES' : 'NO',
      `"${n.details.replace(/"/g, '""')}"`,
      n.openCorpLink || ''
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `investigation_export_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  private _exportToJSON() {
    const data = {
      nodes: this.allNodes,
      edges: this.allEdges,
      exportedAt: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `investigation_graph_${new Date().toISOString().split('T')[0]}.json`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  render() {
    // Google Maps: Initial camera parameters for the <gmp-map-3d> element.
    const initialCenter = '0,0,100'; // lat,lng,altitude
    const initialRange = '20000000'; // View range in meters
    const initialTilt = '45'; // Camera tilt in degrees
    const initialHeading = '0'; // Camera heading in degrees

    return html`<div class="gdm-map-app">
      <div
        class="main-container"
        role="application"
        aria-label="Interactive Map Area">
        ${this.mapError
          ? html`<div
              class="map-error-message"
              role="alert"
              aria-live="assertive"
              >${this.mapError}</div
            >`
          : ''}
        <!-- Google Maps: The core 3D Map custom element -->
        <gmp-map-3d
          id="mapContainer"
          style="height: 100%; width: 100%;"
          aria-label="Google Photorealistic 3D Map Display"
          mode="hybrid"
          center="${initialCenter}"
          heading="${initialHeading}"
          tilt="${initialTilt}"
          range="${initialRange}"
          internal-usage-attribution-ids="gmp_aistudio_threedmapjsmcp_v0.1_showcase"
          default-ui-disabled="true"
          role="application">
        </gmp-map-3d>
        
        <!-- Legend Overlay -->
        <div class="map-legend">
          <div class="legend-title">Investigation Legend</div>
          <div class="legend-item"><span class="dot" style="background: #34A853"></span> Person</div>
          <div class="legend-item"><span class="dot" style="background: #4285F4"></span> Company</div>
          <div class="legend-item"><span class="dot" style="background: #FBBC05"></span> Address</div>
          <div class="legend-item"><span class="dot" style="background: #EA4335"></span> Digital (IP/DNS)</div>
          <div class="legend-item"><span class="dot" style="background: #8B0000"></span> 🚩 Suspicious</div>
        </div>

        <!-- Tooltip Overlay -->
        <div id="mapTooltip" class="map-tooltip hidden"></div>
      </div>
      <div class="sidebar" role="complementary" aria-labelledby="chat-heading">
        <div class="selector" role="tablist" aria-label="Chat providers">
          <button
            id="geminiTab"
            role="tab"
            aria-selected=${this.selectedChatTab === ChatTab.GEMINI}
            aria-controls="chat-panel"
            class=${classMap({
              'selected-tab': this.selectedChatTab === ChatTab.GEMINI,
            })}
            @click=${() => {
              this.selectedChatTab = ChatTab.GEMINI;
            }}>
            <span id="chat-heading">Gemini</span>
          </button>
          <button
            id="databaseTab"
            role="tab"
            aria-selected=${this.selectedChatTab === ChatTab.DATABASE}
            aria-controls="database-panel"
            class=${classMap({
              'selected-tab': this.selectedChatTab === ChatTab.DATABASE,
            })}
            @click=${() => {
              this.selectedChatTab = ChatTab.DATABASE;
            }}>
            <span>Dossiers (${this.allNodes.length})</span>
          </button>
        </div>
        <div
          id="chat-panel"
          role="tabpanel"
          aria-labelledby="geminiTab"
          class=${classMap({
            'tabcontent': true,
            'showtab': this.selectedChatTab === ChatTab.GEMINI,
          })}>
          <div class="chat-messages" aria-live="polite" aria-atomic="false">
            ${this.messages}
            <div id="anchor"></div>
          </div>
          <div class="footer">
            <div
              id="chatStatus"
              aria-live="assertive"
              class=${classMap({'hidden': this.chatState === ChatState.IDLE})}>
              ${this.chatState === ChatState.GENERATING
                ? html`${ICON_BUSY} Generating...`
                : html``}
              ${this.chatState === ChatState.THINKING
                ? html`${ICON_BUSY} Thinking...`
                : html``}
              ${this.chatState === ChatState.EXECUTING
                ? html`${ICON_BUSY} Executing...`
                : html``}
            </div>
            <div
              id="inputArea"
              role="form"
              aria-labelledby="message-input-label">
              <label id="message-input-label" class="hidden"
                >Type your message</label
              >
              <input
                type="text"
                id="messageInput"
                .value=${this.inputMessage}
                @input=${(e: InputEvent) => {
                  this.inputMessage = (e.target as HTMLInputElement).value;
                }}
                @keydown=${(e: KeyboardEvent) => {
                  this.inputKeyDownAction(e);
                }}
                placeholder="Type your message..."
                autocomplete="off"
                aria-labelledby="message-input-label"
                aria-describedby="sendButton-desc" />
              <button
                id="sendButton"
                @click=${() => {
                  this.sendMessageAction();
                }}
                aria-label="Send message"
                aria-describedby="sendButton-desc"
                ?disabled=${this.chatState !== ChatState.IDLE}
                class=${classMap({
                  'disabled': this.chatState !== ChatState.IDLE,
                })}>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  height="30px"
                  viewBox="0 -960 960 960"
                  width="30px"
                  fill="currentColor"
                  aria-hidden="true">
                  <path d="M120-160v-240l320-80-320-80v-240l760 320-760 320Z" />
                </svg>
              </button>
              <p id="sendButton-desc" class="hidden"
                >Sends the typed message to the AI.</p
              >
            </div>
          </div>
        </div>

        <div
          id="database-panel"
          role="tabpanel"
          aria-labelledby="databaseTab"
          class=${classMap({
            'tabcontent': true,
            'showtab': this.selectedChatTab === ChatTab.DATABASE,
          })}>
          <div class="database-view">
             <div class="db-header">
                <h3>Investigation Database</h3>
                <div class="db-actions">
                   <button @click=${this._exportToCSV}>Export CSV</button>
                   <button @click=${this._exportToJSON}>Export JSON</button>
                   <button @click=${this._saveToDrive} class="drive-btn">
                     ${this.isGoogleSignedIn ? 'Save to Drive' : 'Sign In & Save to Drive'}
                   </button>
                </div>
             </div>
             <div class="db-list">
                ${this.allNodes.map(node => html`
                   <div class="db-card ${node.isSuspicious ? 'suspicious' : ''}">
                      <div class="db-card-header">
                         <strong>${node.label}</strong>
                         <span class="type-tag">${node.type}</span>
                      </div>
                      <div class="db-card-body">
                         <p><strong>Location:</strong> ${node.location}</p>
                         <p>${node.details}</p>
                         
                         ${node.timeline && node.timeline.length > 0 ? html`
                            <div class="db-timeline">
                               <strong>Timeline:</strong>
                               ${node.timeline.map(ev => html`
                                  <div class="timeline-row">
                                     <span class="date">${ev.date}</span>
                                     <span class="desc">${ev.event}</span>
                                  </div>
                               `)}
                            </div>
                         ` : ''}

                         ${node.citations && node.citations.length > 0 ? html`
                            <div class="db-citations">
                               <strong>Evidence:</strong>
                               ${node.citations.map(cit => html`
                                  <a href="${cit.link}" target="_blank" class="cit-link">${cit.source}</a>
                               `)}
                            </div>
                         ` : ''}

                         <div class="db-card-links">
                            ${node.openCorpLink ? html`<a href="${node.openCorpLink}" target="_blank">OpenCorporates</a>` : ''}
                            ${node.link ? html`<a href="${node.link}" target="_blank">Verification Link</a>` : ''}
                         </div>
                      </div>
                   </div>
                `)}
             </div>
          </div>
        </div>
      </div>
    </div>`;
  }
}
