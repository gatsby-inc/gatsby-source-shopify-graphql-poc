import { NodeInput, SourceNodesArgs } from "gatsby";
import { createRemoteFileNode } from "gatsby-source-filesystem";

// 'gid://shopify/Metafield/6936247730264'
export const pattern = /^gid:\/\/shopify\/(\w+)\/(.+)$/;

function attachParentId(obj: Record<string, any>) {
  if (obj.__parentId) {
    const [fullId, remoteType] = obj.__parentId.match(pattern) || [];
    const field = remoteType.charAt(0).toLowerCase() + remoteType.slice(1);
    const idField = `${field}Id`;
    obj[idField] = fullId;
    delete obj.__parentId;
  }
}

const downloadImageAndCreateFileNode = async (
  { url, nodeId }: { url: string; nodeId: string },
  {
    actions: { createNode },
    createNodeId,
    cache,
    store,
    reporter,
  }: SourceNodesArgs
): Promise<string> => {
  const fileNode = await createRemoteFileNode({
    url,
    cache,
    createNode,
    createNodeId,
    parentNodeId: nodeId,
    store,
    reporter,
  });

  return fileNode.id;
};

interface ProcessorMap {
  [remoteType: string]: (
    node: NodeInput,
    gatsbyApi: SourceNodesArgs,
    options: ShopifyPluginOptions
  ) => Promise<void>;
}

const processorMap: ProcessorMap = {
  LineItem: async (node) => {
    const lineItem = node;
    lineItem.productId = (lineItem.product as { id: string }).id;
    delete lineItem.product;
  },
  ProductImage: async (node, gatsbyApi, options) => {
    if (options.downloadImages) {
      const url = node.originalSrc as string;
      const fileNodeId = await downloadImageAndCreateFileNode(
        {
          url,
          nodeId: node.id,
        },
        gatsbyApi
      );

      node.localFile = fileNodeId;
    }
  },
  Product: async (node, gatsbyApi, options) => {
    if (options.downloadImages) {
      const featuredImage = node.featuredImage as
        | {
            originalSrc: string;
            localFile: string | undefined;
          }
        | undefined;

      if (featuredImage) {
        const url = featuredImage.originalSrc;
        const fileNodeId = await downloadImageAndCreateFileNode(
          {
            url,
            nodeId: node.id,
          },
          gatsbyApi
        );

        featuredImage.localFile = fileNodeId;
      }
    }
  },
};

export function nodeBuilder(
  gatsbyApi: SourceNodesArgs,
  options: ShopifyPluginOptions
): NodeBuilder {
  return {
    async buildNode(result: BulkResult) {
      if (!pattern.test(result.id)) {
        throw new Error(
          `Expected an ID in the format gid://shopify/<typename>/<id>`
        );
      }

      const [, remoteType] = result.id.match(pattern) || [];

      const processor = processorMap[remoteType] || (() => Promise.resolve());

      attachParentId(result);

      const node = {
        ...result,
        shopifyId: result.id,
        id: gatsbyApi.createNodeId(result.id),
        internal: {
          type: `Shopify${remoteType}`,
          contentDigest: gatsbyApi.createContentDigest(result),
        },
      };

      await processor(node, gatsbyApi, options);

      return node;
    },
  };
}
