var express = require('express')
var app = express()
var bodyParser = require('body-parser')

var jsonParser = bodyParser.json()

var Hexasphere = require('./hexasphere.js')
var shortid = require('shortid');
var redisLibrary = require('redis')
var getPixels = require("get-pixels")
var { createCanvas, loadImage } = require('canvas')
var geolib = require('geolib')
var bluebird = require('bluebird')
bluebird.promisifyAll(redisLibrary.RedisClient.prototype)
bluebird.promisifyAll(redisLibrary.Multi.prototype)

var redis = redisLibrary.createClient()

const {promisify} = require('util');
const getAsync = promisify(redis.get).bind(redis);
const setAsync = promisify(redis.set).bind(redis);
const saddAsync = promisify(redis.sadd).bind(redis);
const smembersAsync = promisify(redis.smembers).bind(redis);
const smoveAsync = promisify(redis.smove).bind(redis);
const georadiusAsync = promisify(redis.georadius).bind(redis);


const RADIUS = 6400
const DIVISIONS = 64
const TILE_SIZE = 1

var players = [
  ['dogPzIz8', 'joel', 45.5, -73.5],
  ['hwX6aOr7', 'mark', 19, -99.1],
  ['a4vhAoFG', 'michael', 33.5, -7.5]
]

redis.on('error', function(err) {
  console.log('ERROR ' + err)
})

function createPlayer(id,name){
  var player = {id:id,name:name,type:'player'}
  redis.set('player:'+player.id,JSON.stringify(player))
  return player
}

function createUnit(type,tileId,playerId){
  var unit = {}
  unit['type'] = type
  unit['tile'] = tileId 
  unit['player'] = playerId
  unit['id']=shortid.generate()
  unit['lastMoveTime'] = (new Date).getTime()
  redis.set('unit:'+unit['id'],JSON.stringify(unit))
  redis.sadd('tile:'+unit['tile']+':occupants',unit['id'])
  redis.sadd('player:'+playerId+':units',unit['id'])
  return unit
}

async function updateUnit(unit){
  await setAsync('unit:'+unit.id,JSON.stringify(unit))
  //redis.sadd('tile:'+unit['tile']+':occupants',unit['id'])
  //redis.sadd('player:'+playerId+':units',unit['id'])
  return unit
}

async function getUnit(unitId){
  var unit = await getAsync('unit:'+unitId)
  unit = JSON.parse(unit)
  var player = await getPlayer(unit.player)
  var unitView = {
    id:unit.id,
    type:unit.type,
    tile:unit.tile,
    player:player.name
  }
  return unitView
}

async function moveUnit(unitId,fromTileId,toTileId){
  var unit = await getAsync('unit:'+unitId)
  unit = JSON.parse(unit)
  console.log(unit)
  unit.tile = toTileId
  await setAsync('unit:'+unit.id,JSON.stringify(unit))
  var returnCode = await smoveAsync('tile:'+fromTileId+':occupants','tile:'+toTileId+':occupants',unitId)
}

async function getPlayer(playerId){
  var player = await getAsync('player:'+playerId)
  player = JSON.parse(player)
    var playerView = {
      name:player.name
    }
    return playerView
 
}

async function getUnitsForPlayer(playerId){
  var player = await getPlayer(playerId)
  var unitIds = await smembersAsync('player:'+playerId+':units')
  var units = []
  for (var i=0;i<unitIds.length;i++){
    var unit = await getUnit(unitIds[i])
    units.push(unit)
  }
  return units
}

async function getTile(tileId){
  var tile = await getAsync('tile:'+tileId)
  tile = JSON.parse(tile)
  var tileView = {
    type:tile.type,
    elevation:tile.elevation,
    id:tile.id,
    neighbors:[],
    occupants:[]
  }

  var occupants = await smembersAsync('tile:'+tileId+':occupants')
  for (var i=0;i<occupants.length;i++){
    var occupant = await getUnit(occupants[i])
    tileView.occupants.push(occupant)
  }

  for (var i=0;i<tile.neighbors.length;i++){
    var neighboringTile = await getAsync('tile:'+tile.neighbors[i])
    neighboringTile = JSON.parse(neighboringTile)
    var bearing = geolib.getBearing(tile.latlon,neighboringTile.latlon)
    tileView.neighbors.push({tile:neighboringTile.id,bearing:bearing})
  }

  return tileView  

}

async function getTileNearestAsync(lat, lon) {
     var replies = await georadiusAsync('tiles', lon, lat, 1000, 'km', 'asc')
     var nearest_tile_id = replies[0]
     var nearestTile = await getAsync(nearest_tile_id)
     nearestTile = JSON.parse(nearestTile)
     return nearestTile 
}
function getTileNearest(lat, lon) {
  return new Promise(function(resolve, reject) {
    return redis.georadiusAsync('tiles', lon, lat, 1000, 'km', 'asc')
      .then(function(replies) {
        var nearest_tile_id = replies[0]
        return nearest_tile_id
      }).then(function(tile_id) {
        return redis.getAsync(tile_id)
          .then(function(tile_string) {
            resolve(JSON.parse(tile_string))
          })
      }).catch(function(err) {
        throw err
      })
  })
}
app.get('/map', async (req, res) => {
  var data = ""
  for (var j=84;j>-84;j-=5){
    data+='\n'
    for (var i=-179;i<180;i+=5){
      var tile = await getTileNearestAsync(j,i)
      if (tile['elevation']){
        data+=' '
      } else {
        data+='x'
      }
    }
  }
  res.send(data)
})
app.get('/tile/:tileId', async (req, res) => {
  var tile = await getTile(req.params.tileId)
  res.send(tile) 
})

app.get('/player/:playerId', async (req, res) => {
  var player = await getPlayer(req.params.playerId)
  res.send(player) 
})

app.get('/player/:playerId/units', async (req, res) => {
  var playerId = req.params.playerId
  var units = await getUnitsForPlayer(playerId)
  res.send(units)
})
app.get('/player/:playerId/units/:unitId', async (req, res) => {
  var playerId = req.params.playerId
  var units = await getUnitsForPlayer(playerId)
  var unitId = req.params.unitId
  var unit = await getUnit(unitId)
  res.send(unit)
})

app.post('/player/:playerId/commands/', jsonParser, async (req, res) => {
  var player = await getPlayer(req.params.playerId)
  var unitId = req.body.unit
  var command = req.body.command
  if (command === "move"){
    var fromTile = req.body.fromTile
    fromTile = await getTile(fromTile)
    var toTile = req.body.toTile
    toTile = await getTile(toTile)
    var unit = await getUnit(unitId)
    if (unit.tile != fromTile.id){
      res.status(400).send('Unit is not located on tile '+fromTile.id)
      return
    } 
    if (!fromTile.neighbors.map(function(q){return q.tile}).includes(toTile.id)){
      res.status(400).send('The target tile is not in range.')
      return
    } 
    if (toTile.elevation <=0){
      res.status(400).send('The target tile is water and you cannot swim. Loser.')
      return
    }
    await moveUnit(unitId,fromTile.id,toTile.id) 
    res.status(200).send('OK')
    return 
  } else {
    res.status(400).send('Unknown command.')
  }
})

app.post('/reset', function(req, res) {
  redis.flushall()

  loadImage('elevation.png').then((image) => {
    const canvas = createCanvas(image.width, image.height)
    console.log(image.width)
    console.log(image.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0, image.width, image.height)
    var pixelData = ctx.getImageData(0, 0, image.width, image.height)

    var hexasphere = new Hexasphere(RADIUS, DIVISIONS, TILE_SIZE)

    for (var i = 0; i < hexasphere.tiles.length; i++) {
      var tile = hexasphere.tiles[i]
      tile['id'] = shortid.generate()
    }
    for (var i = 0; i < hexasphere.tiles.length; i++) {
      var tile = hexasphere.tiles[i]
      var neighborTileIds = []
      for (var j = 0; j < tile.neighbors.length; j++) {
        neighborTileIds.push(tile.neighbors[j]['id'])
      }
      var t = tile.toJson()
      t['type'] = 'tile'
      t['id'] = tile['id']
      t['neighbors'] = neighborTileIds
      t['latlon'] = tile.getLatLon(RADIUS)
      var latlon = tile.getLatLon(RADIUS)
      var x = parseInt(image.width * (latlon.lon + 180) / 360);
      var y = image.height - parseInt(image.height * (latlon.lat + 90) / 180);
      t['elevation'] = pixelData.data[(y * pixelData.width + x) * 4]
      if (latlon.lat < 85 && latlon.lat > -85) {
        redis.geoadd('tiles', latlon.lon, latlon.lat, t['type'] + ':' + tile['id'])
      }
      redis.set(t['type'] + ':' + tile['id'], JSON.stringify(t))

    }
  }).then(function() {
    var sequence = Promise.resolve()

    players.forEach(function(player) {
      sequence = sequence.then(function() {
        getTileNearest(player[2], player[3])
          .then(function(nearest_tile) {
            var playerObject = createPlayer(player[0],player[1])
            for (var k = 0; k < 10; k++){
              var unit = createUnit('human',nearest_tile['id'],playerObject.id)
            }
              var unit = createUnit('ship',nearest_tile['id'],playerObject.id)
            return
          })
      })
    })

  }).then(function() {
    res.setHeader('Content-Type', 'application/json');
    res.send('tiles generated.')
  })
})

app.listen(80, () => console.log('gaea is running on port 80'))

