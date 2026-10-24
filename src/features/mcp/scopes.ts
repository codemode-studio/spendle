/**
 * The OAuth scope that lets an MCP client change data: categories, notes,
 * one-off marks, rules, caps and recurrences. Without it a client only
 * reads (and refreshes Open Finance). The person grants it on `/autorizar`.
 */
export const mcpWriteScope = 'spendle:write'
