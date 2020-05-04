// Copyright 2019 Campbell Crowley. All rights reserved.
// Author: Campbell Crowley (web@campbellcrowley.com)

/**
 * Manages dragging players around in the HG player view.
 *
 * @public
 * @param {Socket} socket Websocket to inform server about player changes.
 */
function HGDragging(socket) {/* eslint-disable-line no-unused-vars */
  let draggable = [];
  let droppable = [];
  let dragObj;
  let guildId = 0;
  let touchTimeout = null;
  const touch = {x: 0, y: 0};
  let touchEvent = null;

  /**
   * Handler for touch start.
   * @private
   * @param {Event} event DOM event.
   */
  function handleTouchStart(event) {
    event.stopPropagation();
    const me = this;
    clearTimeout(touchTimeout);
    touchTimeout = setTimeout(
        (function(e) {
          return function() {
            handleTouchHold.call(me, e);
          };
        })(event),
        100);
    touch.x = event.touches[0].clientX;
    touch.y = event.touches[0].clientY;
  }
  /**
   * Handler for touch move. Cancels touch hold.
   * @private
   * @param {Event} event DOM event.
   */
  function handleTouchMove(event) {
    let x = event.touches[0].clientX;
    let y = event.touches[0].clientY;
    if (Math.abs(x - touch.x) > 2 || Math.abs(y - touch.y) > 2) {
      clearTimeout(touchTimeout);
    }
  }
  /**
   * Handler for touch end. Cancels touch hold.
   * @private
   */
  function handleTouchEnd() {
    clearTimeout(touchTimeout);
  }
  /**
   * Handler for touch and hold for extended time.
   * @private
   * @param {Event} event Touch start event.
   */
  function handleTouchHold(event) {
    event.preventDefault();
    // console.log('Touch:', this);
    if (this != dragObj && (this.classList.contains('droppable') ||
                            this.classList.contains('draggable')) &&
        dragObj && dragObj.classList.contains('selected')) {
      if (this.tagName == 'input') this.blur();
      handleDrop.call(this, touchEvent);
      handleDragEnd.call(this, touchEvent);
    } else if (this.classList.contains('selected')) {
      handleDragEnd.call(this, touchEvent);
    } else if (this.classList.contains('draggable')) {
      handleDragStart.call(this, event);
      dragObj.classList.add('selected');
      dragObj.style.opacity = null;
      touchEvent = event;
    }
  }
  /**
   * Handler for a drag starting.
   * @private
   * @param {DragStartEvent} event Drag start event.
   */
  function handleDragStart(event) {
    event.dataTransfer.setData('Text', this.id);
    for (let i in droppable) {
      if (!droppable[i].classList) continue;
      droppable[i].draggable = true;
      droppable[i].ondragenter = handleDragEnter;
      droppable[i].ondragover = handleDragOver;
      droppable[i].ondragleave = handleDragLeave;
      droppable[i].ondrop = handleDrop;
      droppable[i].ontouchstart = handleTouchStart;
      droppable[i].ontouchend = handleTouchEnd;
      droppable[i].classList.add('dragging');
    }
    this.style.opacity = 0.4;
    if (dragObj) dragObj.classList.remove('selected');
    dragObj = this;
  }
  /**
   * Handler for drag ending.
   * @private
   * @param {Event} event
   * @return {boolean}
   */
  function handleDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    return false;
  }
  /**
   * Handler for dragging over an element.
   * @private
   */
  function handleDragEnter() {
    this.classList.add('over');
  }
  /**
   * Handler for dragging no longer over an element.
   * @private
   */
  function handleDragLeave() {
    this.classList.remove('over');
  }
  /**
   * Handler for dropping a dragged element.
   * @private
   * @param {Event} event
   * @return {boolean}
   */
  function handleDrop(event) {
    event.stopPropagation();
    if (dragObj != this) {
      let dragDir = null;
      const leftCol = document.getElementById('playerLeft');
      const rightCol = document.getElementById('playerRight');
      if ((this.parentNode.id == 'playerLeft' ||
           this.parentNode.parentNode.id == 'playerLeft' ||
           this.parentNode.parentNode.parentNode.id == 'playerLeft') &&
          (dragObj.parentNode.parentNode.id == 'playerRight' ||
           dragObj.parentNode.parentNode.parentNode.id == 'playerRight')) {
        dragDir = 'left';
      } else if (
          (this.parentNode.id == 'playerRight' ||
           this.parentNode.parentNode.id == 'playerRight' ||
           this.parentNode.parentNode.parentNode.id == 'playerRight') &&
          (dragObj.parentNode.parentNode.id == 'playerLeft' ||
           dragObj.parentNode.parentNode.parentNode.id == 'playerLeft')) {
        dragDir = 'right';
      }
      // console.log('DRAG', dragDir, this, dragObj);
      const leftObj = leftCol.getElementsByClassName(dragObj.id)[0];
      const rightObj = rightCol.getElementsByClassName(dragObj.id)[0];
      // console.log('L', leftObj, 'R', rightObj);
      if (dragDir == 'left' && this.parentNode.id == leftCol.id) {
        console.log('Including', dragObj.id);
        socket.emit('includeMember', guildId, dragObj.id, function() {
          // socket.emit('fetchGames', guildId);
        });
        if (leftObj) {
          leftObj.children[0].children[0].checked = true;
          leftObj.classList.remove('hidden');
        }
        rightObj.children[0].children[0].checked = true;
      } else if (dragDir == 'right' && this.parentNode.id == rightCol.id) {
        console.log('Excluding', dragObj.id);
        socket.emit('excludeMember', guildId, dragObj.id, function() {
          // socket.emit('fetchGames', guildId);
        });
        if (rightObj) rightObj.children[0].children[0].checked = false;
        leftObj.children[0].children[0].checked = false;
        leftObj.classList.add('hidden');
        if (leftObj.parentNode.children.length == 2) {
          leftObj.parentNode.remove();
        }
        leftCol.children[1].appendChild(leftObj);
      } else if (!this.id.startsWith('team')) {
        if (this.parentNode.classList.contains('playerListTeam') &&
            dragObj.parentNode.classList.contains('playerListTeam')) {
          // console.log('Swapping:', this.id, dragObj.id);
          swapElements(this, dragObj);
          socket.emit('editTeam', guildId, 'swap', this.id, dragObj.id);
        } else if (dragDir == 'left') {
          // Excluded dragged on top of included. Swap.
          // console.log('Including:', dragObj.id, 'Excluding:', this.id);
          socket.emit('includeMember', guildId, dragObj.id, function() {
            // socket.emit('fetchGames', guildId);
          });
          if (this.parentNode.classList.contains('playerListTeam')) {
            socket.emit('editTeam', guildId, 'move', dragObj.id, this.id);
          }
          socket.emit('excludeMember', guildId, this.id, function() {
            // socket.emit('fetchGames', guildId);
          });

          rightObj.children[0].children[0].checked = true;
          leftObj.children[0].children[0].checked = true;
          leftObj.classList.remove('hidden');

          const exLeft = leftCol.getElementsByClassName(this.id)[0];
          const exRight = rightCol.getElementsByClassName(this.id)[0];
          exRight.children[0].children[0].checked = false;
          exLeft.children[0].children[0].checked = false;
          exLeft.classList.add('hidden');
          exLeft.parentNode.appendChild(leftObj);
          leftCol.children[1].appendChild(exLeft);
        } else if (dragDir == 'right') {
          // Included dragged on top of excluded. Exclude.
          // console.log('Excluding:', dragObj.id);
          socket.emit('excludeMember', guildId, dragObj.id, function() {
            // socket.emit('fetchGames', guildId);
          });
          if (rightObj) rightObj.children[0].children[0].checked = false;
          leftObj.children[0].children[0].checked = false;
          leftObj.classList.add('hidden');
          if (leftObj.parentNode.children.length == 2 &&
              this != leftObj.parentNode) {
            leftObj.parentNode.remove();
          }
          leftCol.children[1].appendChild(leftObj);
        }
      } else {
        // console.log('Moving:', dragObj.id, this.id.substring(4));
        if (dragDir == 'left') {
          socket.emit('includeMember', guildId, dragObj.id);
        }
        rightObj.children[0].children[0].checked = true;
        leftObj.children[0].children[0].checked = true;
        socket.emit(
            'editTeam', guildId, 'move', dragObj.id, this.id.substring(4),
            function() {
              if (dragObj.parentNode.id.substring(4) == 'New') {
                socket.emit('fetchGames', guildId);
              }
            });
        if (dragObj.parentNode.id.substring(4) == 'New') return;
        leftObj.classList.remove('hidden');
        if (leftObj.parentNode.children.length == 2 &&
            this != leftObj.parentNode) {
          leftObj.parentNode.remove();
        }
        this.appendChild(leftObj);
      }
    }
    return false;
  }
  /**
   * Handler for drag ending.
   * @private
   */
  function handleDragEnd() {
    this.style.opacity = 1.0;
    for (let i in draggable) {
      if (!draggable[i].classList) continue;
      draggable[i].classList.remove('over');
    }
    for (let i in droppable) {
      if (!droppable[i].classList) continue;
      droppable[i].classList.remove('over');
      droppable[i].draggable = false;
      droppable[i].classList.remove('dragging');
    }
    if (dragObj) dragObj.classList.remove('selected');
  }
  /**
   * Update the currently selected guild.
   * @public
   * @param {?string} gId The guild id or null if no guild.
   */
  this.update = function(gId) {
    guildId = gId;
    draggable = document.getElementsByClassName('draggable');
    droppable = document.getElementsByClassName('droppable');
    for (let i in draggable) {
      if (!draggable[i] || !draggable[i].classList) continue;
      draggable[i].ondragstart = handleDragStart;
      draggable[i].ondragenter = handleDragEnter;
      draggable[i].ondragover = handleDragOver;
      draggable[i].ondragleave = handleDragLeave;
      draggable[i].ondrop = handleDrop;
      draggable[i].ondragend = handleDragEnd;
      draggable[i].ontouchstart = handleTouchStart;
      draggable[i].ontouchend = handleTouchEnd;
    }
    window.ontouchmove = handleTouchMove;
  };
  this.update();
}
